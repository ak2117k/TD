import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  TickData,
  FeedCallback,
  BrokerAdapter,
} from '../../../common/interfaces/broker-adapter.interface';
import { Quote, Exchange } from '@td/shared/types';
import {
  MARKET_OPEN_HOUR,
  MARKET_OPEN_MINUTE,
  MARKET_CLOSE_HOUR,
  MARKET_CLOSE_MINUTE,
  ANGEL_ONE_WEBSOCKET_MAX_TOKENS,
  INDICES,
} from '@td/shared/constants';
import { CandleAggregatorService } from './candle-aggregator.service';
import { InstrumentService } from './instrument.service';
import { MarketDataGateway, CandlePayload } from '../gateways/market-data.gateway';

/** Redis pub/sub channel for tick distribution across services. */
const REDIS_TICKS_CHANNEL = 'market:ticks';

/**
 * Injection token for the broker adapter.
 * The AngelOneAdapterService (built by another agent) should be provided
 * under this token. If unavailable, MarketFeedService degrades gracefully.
 */
export const BROKER_ADAPTER_TOKEN = 'BROKER_ADAPTER';

/**
 * Subscription slot allocation:
 *   Slots  1-30: Primary watchlist (user-selected tokens)
 *   Slots 31-50: Scan rotation (strategy scanner tokens)
 */
const PRIMARY_SLOT_MAX = 30;
const TOTAL_SLOT_MAX = ANGEL_ONE_WEBSOCKET_MAX_TOKENS; // 50

@Injectable()
export class MarketFeedService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketFeedService.name);

  /** In-memory latest quote cache — fast access for REST and gateway. */
  private readonly quoteCache = new Map<string, Quote>();

  /** Tokens currently subscribed as primary watchlist. */
  private readonly primaryTokens = new Set<string>();

  /** Tokens currently subscribed for scan rotation. */
  private readonly scanTokens = new Set<string>();

  /** Whether the feed is actively running. */
  private feedActive = false;

  /** Redis publisher for cross-service tick distribution. */
  private redisPub: Redis | null = null;

  /** Redis subscriber for receiving ticks from other processes. */
  private redisSub: Redis | null = null;

  /** Handle returned by the broker adapter callback registration. */
  private feedCallback: FeedCallback | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly candleAggregator: CandleAggregatorService,
    private readonly instrumentService: InstrumentService,
    private readonly gateway: MarketDataGateway,
    @Optional()
    @Inject(BROKER_ADAPTER_TOKEN)
    private readonly brokerAdapter: BrokerAdapter | null,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.initRedis();

    // Register candle close listener so we can push to the gateway
    this.candleAggregator.onCandleClose((candle) => {
      const payload: CandlePayload = {
        token: candle.token,
        timeframe: candle.timeframe,
        timestamp: candle.timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      };
      this.gateway.emitCandle(payload);
    });

    this.logger.log('MarketFeedService initialized');
  }

  async onModuleDestroy(): Promise<void> {
    await this.stopFeed();
    await this.redisPub?.quit();
    await this.redisSub?.quit();
  }

  // ------------------------------------------------------------------
  //  Public API
  // ------------------------------------------------------------------

  /**
   * Start the live market data feed.
   * Subscribes to major indices by default.
   */
  async startFeed(): Promise<void> {
    if (this.feedActive) {
      this.logger.warn('Feed is already active');
      return;
    }

    if (!this.brokerAdapter) {
      this.logger.warn(
        'No broker adapter available — feed will not connect to live market. ' +
          'Serving cached data only.',
      );
      this.feedActive = true;
      this.broadcastStatus();
      return;
    }

    try {
      this.feedCallback = (tick: TickData) => this.handleTick(tick);

      // Subscribe to major indices by default
      const indexTokens = Object.values(INDICES).map((idx) => idx.token);
      await this.subscribe(indexTokens);

      this.feedActive = true;
      this.broadcastStatus();
      this.logger.log('Market data feed started');
    } catch (error) {
      this.logger.error(
        `Failed to start feed: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  /**
   * Stop the live feed and flush all in-progress candles to the database.
   */
  async stopFeed(): Promise<void> {
    if (!this.feedActive) return;

    try {
      if (this.brokerAdapter) {
        const allTokens = [
          ...Array.from(this.primaryTokens),
          ...Array.from(this.scanTokens),
        ];
        if (allTokens.length > 0) {
          this.brokerAdapter.unsubscribeFromFeed(allTokens);
        }
      }

      await this.candleAggregator.flushAll();

      this.primaryTokens.clear();
      this.scanTokens.clear();
      this.feedActive = false;
      this.broadcastStatus();
      this.logger.log('Market data feed stopped');
    } catch (error) {
      this.logger.error(
        `Error stopping feed: ${error instanceof Error ? error.message : error}`,
      );
      this.feedActive = false;
    }
  }

  /**
   * Subscribe tokens to the live feed in the primary watchlist slots.
   */
  async subscribe(tokens: string[]): Promise<string[]> {
    const toSubscribe: string[] = [];

    for (const token of tokens) {
      if (this.primaryTokens.has(token) || this.scanTokens.has(token)) {
        continue; // Already subscribed
      }
      if (this.primaryTokens.size >= PRIMARY_SLOT_MAX) {
        this.logger.warn(
          `Primary slot limit (${PRIMARY_SLOT_MAX}) reached — cannot subscribe ${token}`,
        );
        break;
      }
      this.primaryTokens.add(token);
      toSubscribe.push(token);
    }

    if (toSubscribe.length > 0) {
      await this.registerTokensWithBroker(toSubscribe);
      await this.ensureInstrumentMappings(toSubscribe);
    }

    return toSubscribe;
  }

  /**
   * Unsubscribe tokens from the live feed.
   */
  async unsubscribe(tokens: string[]): Promise<string[]> {
    const toUnsubscribe: string[] = [];

    for (const token of tokens) {
      if (this.primaryTokens.delete(token)) {
        toUnsubscribe.push(token);
      }
      if (this.scanTokens.delete(token)) {
        toUnsubscribe.push(token);
      }
    }

    if (toUnsubscribe.length > 0 && this.brokerAdapter) {
      try {
        this.brokerAdapter.unsubscribeFromFeed(toUnsubscribe);
      } catch (error) {
        this.logger.error(
          `Failed to unsubscribe tokens from broker: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    return toUnsubscribe;
  }

  /**
   * Subscribe tokens in the scan rotation slots (31-50).
   * Used by the strategy scanner for temporary subscriptions.
   */
  async subscribeScan(tokens: string[]): Promise<string[]> {
    const maxScanSlots = TOTAL_SLOT_MAX - PRIMARY_SLOT_MAX;
    const toSubscribe: string[] = [];

    // Clear existing scan tokens to make room
    if (this.scanTokens.size + tokens.length > maxScanSlots) {
      const currentScan = Array.from(this.scanTokens);
      if (currentScan.length > 0 && this.brokerAdapter) {
        this.brokerAdapter.unsubscribeFromFeed(currentScan);
      }
      this.scanTokens.clear();
    }

    for (const token of tokens) {
      if (this.primaryTokens.has(token) || this.scanTokens.has(token)) {
        continue;
      }
      if (this.scanTokens.size >= maxScanSlots) break;
      this.scanTokens.add(token);
      toSubscribe.push(token);
    }

    if (toSubscribe.length > 0) {
      await this.registerTokensWithBroker(toSubscribe);
      await this.ensureInstrumentMappings(toSubscribe);
    }

    return toSubscribe;
  }

  /**
   * Get the latest cached quote for a token.
   */
  getQuote(token: string): Quote | null {
    return this.quoteCache.get(token) ?? null;
  }

  /**
   * Get all cached quotes.
   */
  getAllQuotes(): Quote[] {
    return Array.from(this.quoteCache.values());
  }

  /**
   * Get feed status information.
   */
  getStatus(): {
    feedActive: boolean;
    primarySubscriptions: number;
    scanSubscriptions: number;
    totalSubscriptions: number;
    cachedQuotes: number;
    connectedClients: number;
    brokerAdapterAvailable: boolean;
  } {
    return {
      feedActive: this.feedActive,
      primarySubscriptions: this.primaryTokens.size,
      scanSubscriptions: this.scanTokens.size,
      totalSubscriptions: this.primaryTokens.size + this.scanTokens.size,
      cachedQuotes: this.quoteCache.size,
      connectedClients: this.gateway.getConnectedClientCount(),
      brokerAdapterAvailable: this.brokerAdapter !== null,
    };
  }

  /**
   * Get the set of all currently subscribed tokens.
   */
  getSubscribedTokens(): string[] {
    return [
      ...Array.from(this.primaryTokens),
      ...Array.from(this.scanTokens),
    ];
  }

  /**
   * Check whether we are within Indian market hours.
   */
  isMarketOpen(): boolean {
    const now = new Date();
    // Convert to IST (UTC+5:30)
    const istOffset = 5.5 * 60 * 60 * 1000;
    const ist = new Date(now.getTime() + istOffset + now.getTimezoneOffset() * 60 * 1000);
    const hours = ist.getHours();
    const minutes = ist.getMinutes();
    const totalMinutes = hours * 60 + minutes;
    const marketOpen = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MINUTE;
    const marketClose = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MINUTE;
    return totalMinutes >= marketOpen && totalMinutes <= marketClose;
  }

  // ------------------------------------------------------------------
  //  Core tick handler
  // ------------------------------------------------------------------

  /**
   * Process an incoming tick from the broker adapter.
   * This is the central data distribution point.
   */
  private handleTick(tick: TickData): void {
    try {
      // 1. Update in-memory quote cache
      const quote = this.tickToQuote(tick);
      this.quoteCache.set(tick.token, quote);

      // 2. Publish to Redis for cross-service distribution
      this.publishToRedis(tick);

      // 3. Pass to candle aggregator
      this.candleAggregator.processTick(tick);

      // 4. Emit live tick to frontend via WebSocket gateway
      this.gateway.emitTick(quote);
    } catch (error) {
      this.logger.error(
        `Error processing tick for ${tick.token}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // ------------------------------------------------------------------
  //  Redis pub/sub
  // ------------------------------------------------------------------

  private async initRedis(): Promise<void> {
    try {
      const redisHost = this.configService.get<string>('redis.host', 'localhost');
      const redisPort = this.configService.get<number>('redis.port', 6379);
      const redisPassword = this.configService.get<string>('redis.password') || undefined;

      const redisOptions = { host: redisHost, port: redisPort, password: redisPassword };

      this.redisPub = new Redis(redisOptions);
      this.redisSub = new Redis(redisOptions);

      this.redisPub.on('error', (err) =>
        this.logger.error(`Redis pub error: ${err.message}`),
      );
      this.redisSub.on('error', (err) =>
        this.logger.error(`Redis sub error: ${err.message}`),
      );

      // Subscribe to ticks channel for cross-service communication
      await this.redisSub.subscribe(REDIS_TICKS_CHANNEL);
      this.redisSub.on('message', (_channel, message) => {
        try {
          const tick: TickData = JSON.parse(message);
          tick.timestamp = new Date(tick.timestamp);
          // Update local cache from ticks published by other processes
          const quote = this.tickToQuote(tick);
          this.quoteCache.set(tick.token, quote);
        } catch {
          // Ignore malformed messages
        }
      });

      this.logger.log('Redis pub/sub connections established');
    } catch (error) {
      this.logger.error(
        `Failed to initialize Redis: ${error instanceof Error ? error.message : error}. ` +
          'Continuing without Redis pub/sub.',
      );
    }
  }

  private publishToRedis(tick: TickData): void {
    if (!this.redisPub) return;

    this.redisPub
      .publish(REDIS_TICKS_CHANNEL, JSON.stringify(tick))
      .catch((err) =>
        this.logger.error(`Redis publish error: ${err.message}`),
      );
  }

  // ------------------------------------------------------------------
  //  Helpers
  // ------------------------------------------------------------------

  private tickToQuote(tick: TickData): Quote {
    const previousQuote = this.quoteCache.get(tick.token);
    const prevClose = previousQuote?.close ?? tick.close;
    const change = tick.ltp - prevClose;
    const changePercent = prevClose !== 0 ? (change / prevClose) * 100 : 0;

    return {
      symbol: tick.symbol,
      token: tick.token,
      exchange: (tick as any).exchange ?? Exchange.NSE,
      ltp: tick.ltp,
      open: tick.open,
      high: tick.high,
      low: tick.low,
      close: tick.close,
      volume: tick.volume,
      change: Math.round(change * 100) / 100,
      changePercent: Math.round(changePercent * 100) / 100,
      timestamp: tick.timestamp,
    };
  }

  private async registerTokensWithBroker(tokens: string[]): Promise<void> {
    if (!this.brokerAdapter || !this.feedCallback) return;

    try {
      this.brokerAdapter.subscribeToFeed(tokens, this.feedCallback);
    } catch (error) {
      this.logger.error(
        `Failed to register tokens with broker: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Ensure the candle aggregator has instrumentId mappings for the given tokens.
   */
  private async ensureInstrumentMappings(tokens: string[]): Promise<void> {
    for (const token of tokens) {
      const instrument = await this.instrumentService.getByToken(token);
      if (instrument) {
        this.candleAggregator.setTokenInstrumentId(token, instrument.id);
      }
    }
  }

  private broadcastStatus(): void {
    this.gateway.emitConnectionStatus({
      connected: this.feedActive,
      activeSubscriptions: this.primaryTokens.size + this.scanTokens.size,
      timestamp: new Date(),
    });
  }
}
