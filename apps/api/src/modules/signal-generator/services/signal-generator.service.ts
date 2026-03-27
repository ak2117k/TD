import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  MarketSnapshot,
  SignalOutput,
} from '../../../common/interfaces/trading-strategy.interface';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { SettingsService } from '../../settings/services/settings.service';
import { StrategyRegistryService } from './strategy-registry.service';
import { SignalScoringService } from './signal-scoring.service';
import { SignalRepository, CreateSignalInput } from '../repositories/signal.repository';
import { SignalGateway } from '../gateways/signal.gateway';
import { SignalFilterDto } from '../dto/signal.dto';
import { TIMEFRAMES } from '@td/shared/constants';

/** Default signal expiry for intraday in minutes. */
const DEFAULT_EXPIRY_MINUTES = 30;

/** Minimum number of timeframes that must agree for signal confirmation. */
const MIN_TIMEFRAME_AGREEMENT = 2;

@Injectable()
export class SignalGeneratorService {
  private readonly logger = new Logger(SignalGeneratorService.name);

  constructor(
    private readonly strategyRegistry: StrategyRegistryService,
    private readonly signalScoring: SignalScoringService,
    private readonly signalRepository: SignalRepository,
    private readonly marketFeedService: MarketFeedService,
    private readonly marketDataRepository: MarketDataRepository,
    private readonly settingsService: SettingsService,
    private readonly signalGateway: SignalGateway,
  ) {}

  /**
   * Run all active strategies against a market snapshot.
   * Scores results, filters by multi-timeframe confirmation, saves to DB,
   * and emits via WebSocket gateway.
   */
  async scanForSignals(snapshot: MarketSnapshot): Promise<void> {
    const strategies = await this.strategyRegistry.getActiveStrategies();

    if (strategies.length === 0) {
      this.logger.debug('No active strategies to scan with');
      return;
    }

    const rawSignals: Array<{ signal: SignalOutput; strategyName: string }> = [];

    for (const strategy of strategies) {
      try {
        const signal = strategy.analyze(snapshot);
        if (signal) {
          rawSignals.push({ signal, strategyName: strategy.name });
        }
      } catch (error) {
        this.logger.error(
          `Strategy "${strategy.name}" error for ${snapshot.symbol}: ` +
            `${error instanceof Error ? error.message : error}`,
        );
      }
    }

    if (rawSignals.length === 0) {
      return;
    }

    // Multi-timeframe confirmation: count how many signals agree on direction
    const directionCounts = this.countDirectionAgreements(rawSignals);

    for (const { signal, strategyName } of rawSignals) {
      const timeframeAlignments = directionCounts[signal.side] ?? 1;

      // Skip signals that don't meet multi-timeframe minimum
      if (timeframeAlignments < MIN_TIMEFRAME_AGREEMENT && rawSignals.length > 1) {
        this.logger.debug(
          `Signal for ${signal.symbol} ${signal.side} skipped — ` +
            `only ${timeframeAlignments} TF agreement (need ${MIN_TIMEFRAME_AGREEMENT})`,
        );
        continue;
      }

      const scoreResult = await this.signalScoring.scoreSignal(
        signal,
        snapshot,
        strategyName,
        timeframeAlignments,
      );

      if (!scoreResult) {
        continue; // Discarded by scoring (below threshold)
      }

      try {
        const savedSignal = await this.saveSignal(
          signal,
          snapshot,
          strategyName,
          scoreResult.score,
          scoreResult.confidence,
        );

        this.signalGateway.emitNewSignal(savedSignal);

        this.logger.log(
          `Signal generated: ${signal.symbol} ${signal.side} @ ${signal.entryPrice} ` +
            `[${strategyName}] score=${scoreResult.score} (${scoreResult.confidence})`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to save signal for ${signal.symbol}: ` +
            `${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  /**
   * Scan all instruments in the current watchlist.
   */
  async scanAllWatchlist(): Promise<void> {
    const tokens = this.marketFeedService.getSubscribedTokens();

    if (tokens.length === 0) {
      this.logger.debug('No subscribed tokens to scan');
      return;
    }

    this.logger.log(`Scanning ${tokens.length} instruments for signals`);

    for (const token of tokens) {
      try {
        const snapshot = await this.buildSnapshotForToken(token);
        if (snapshot) {
          await this.scanForSignals(snapshot);
        }
      } catch (error) {
        this.logger.error(
          `Error scanning token ${token}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  /**
   * Get all currently active (non-expired) signals sorted by confidence.
   */
  async getActiveSignals() {
    return this.signalRepository.getActiveSignals();
  }

  /**
   * Get signal history with filters and pagination.
   */
  async getSignalHistory(filters: SignalFilterDto) {
    return this.signalRepository.getSignalHistory(filters);
  }

  /**
   * Deactivate a signal by ID.
   */
  async deactivateSignal(id: string) {
    const signal = await this.signalRepository.deactivateSignal(id);
    this.signalGateway.emitSignalExpired(id);
    return signal;
  }

  /**
   * Cron job to expire old signals.
   * Runs every 5 minutes during market hours.
   */
  @Cron('*/5 9-15 * * 1-5')
  async expireOldSignals(): Promise<void> {
    if (!this.marketFeedService.isMarketOpen()) {
      return;
    }

    try {
      const settings = await this.settingsService.getSettings();
      const maxAgeMinutes = DEFAULT_EXPIRY_MINUTES;

      const count = await this.signalRepository.deactivateExpiredSignals(maxAgeMinutes);

      if (count > 0) {
        this.logger.log(`Expired ${count} old signals`);
      }
    } catch (error) {
      this.logger.error(
        `Error expiring signals: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // ------------------------------------------------------------------
  //  Private helpers
  // ------------------------------------------------------------------

  /**
   * Build a MarketSnapshot from a token's cached quote and recent candles.
   */
  private async buildSnapshotForToken(
    token: string,
  ): Promise<MarketSnapshot | null> {
    const quote = this.marketFeedService.getQuote(token);
    if (!quote) {
      return null;
    }

    // Fetch recent candles (last 50 x 5-min candles ~ 4 hours of data)
    const now = new Date();
    const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);

    let candles: Array<{
      timestamp: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: bigint | number;
    }> = [];

    try {
      // Look up instrument by token to get instrumentId
      const instrument = await this.marketDataRepository.getInstrumentByToken(token);
      if (instrument) {
        const dbCandles = await this.marketDataRepository.getCandles(
          instrument.id,
          TIMEFRAMES.FIVE_MIN,
          fourHoursAgo,
          now,
        );
        candles = dbCandles;
      }
    } catch (error) {
      this.logger.debug(
        `Could not fetch candles for token ${token}: ${error instanceof Error ? error.message : error}`,
      );
    }

    return {
      symbol: quote.symbol,
      exchange: quote.exchange,
      ltp: quote.ltp,
      volume: quote.volume,
      candles: candles.map((c) => ({
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: typeof c.volume === 'bigint' ? Number(c.volume) : c.volume,
      })),
    };
  }

  /**
   * Count how many signals agree on each direction (BUY/SELL).
   * Used for multi-timeframe confirmation.
   */
  private countDirectionAgreements(
    signals: Array<{ signal: SignalOutput; strategyName: string }>,
  ): Record<string, number> {
    const counts: Record<string, number> = { BUY: 0, SELL: 0 };

    // Count unique timeframes per direction
    const buyTimeframes = new Set<string>();
    const sellTimeframes = new Set<string>();

    for (const { signal } of signals) {
      if (signal.side === 'BUY') {
        buyTimeframes.add(signal.timeframe);
      } else {
        sellTimeframes.add(signal.timeframe);
      }
    }

    counts.BUY = buyTimeframes.size;
    counts.SELL = sellTimeframes.size;

    return counts;
  }

  /**
   * Save a scored signal to the database.
   */
  private async saveSignal(
    signal: SignalOutput,
    snapshot: MarketSnapshot,
    strategyName: string,
    score: number,
    confidence: string,
  ) {
    // Resolve instrumentId from the symbol/exchange
    let instrumentId: string | null = null;

    try {
      const instruments = await this.marketDataRepository.searchInstruments(
        signal.symbol,
        signal.exchange,
      );
      if (instruments.length > 0) {
        instrumentId = instruments[0].id;
      }
    } catch {
      // Will use a fallback if instrument not found
    }

    if (!instrumentId) {
      this.logger.warn(
        `Instrument not found for ${signal.symbol}/${signal.exchange} — skipping signal save`,
      );
      throw new Error(`Instrument not found for ${signal.symbol}`);
    }

    const expectedProfit = Math.abs(signal.targetPrice - signal.entryPrice);
    const expectedLoss = Math.abs(signal.entryPrice - signal.stoplossPrice);
    const riskRewardRatio = expectedLoss > 0 ? expectedProfit / expectedLoss : 0;

    const expiresAt = new Date(
      Date.now() + DEFAULT_EXPIRY_MINUTES * 60 * 1000,
    );

    const input: CreateSignalInput = {
      instrumentId,
      side: signal.side,
      entryPrice: signal.entryPrice,
      targetPrice: signal.targetPrice,
      stoplossPrice: signal.stoplossPrice,
      expectedProfit: Math.round(expectedProfit * 100) / 100,
      expectedLoss: Math.round(expectedLoss * 100) / 100,
      riskRewardRatio: Math.round(riskRewardRatio * 100) / 100,
      confidence,
      confidenceScore: score,
      strategy: strategyName,
      timeframe: signal.timeframe,
      reason: signal.reason,
      expiresAt,
    };

    return this.signalRepository.createSignal(input);
  }
}
