import {
  Controller,
  Get,
  Post,
  Query,
  Param,
  Body,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiParam } from '@nestjs/swagger';
import { MarketFeedService } from '../services/market-feed.service';
import { InstrumentService } from '../services/instrument.service';
import { CandleAggregatorService } from '../services/candle-aggregator.service';
import { MarketDataRepository } from '../repositories/market-data.repository';
import { AngelOneAdapterService } from '../services/angel-one-adapter.service';
import {
  SubscribeDto,
  UnsubscribeDto,
  SearchInstrumentDto,
  GetCandlesQueryDto,
  GetOIQueryDto,
} from '../dto/market-data.dto';
import {
  INDICES,
  SECTOR_INDICES,
  MAJOR_STOCKS,
  COMMODITIES,
} from '@td/shared/constants';

/**
 * Look up a symbol and exchange for a token from the known constant maps.
 * Returns `{ symbol, exchange }` if found, or `null` if the token is unknown.
 */
function resolveTokenFromConstants(
  token: string,
): { symbol: string; exchange: string } | null {
  for (const entry of Object.values(INDICES)) {
    if (entry.token === token) return { symbol: entry.symbol, exchange: entry.exchange };
  }
  for (const entry of Object.values(SECTOR_INDICES)) {
    if (entry.token === token) return { symbol: entry.symbol, exchange: entry.exchange };
  }
  for (const entry of Object.values(MAJOR_STOCKS)) {
    if (entry.token === token) return { symbol: entry.symbol, exchange: entry.exchange };
  }
  for (const entry of Object.values(COMMODITIES)) {
    if (entry.token === token) return { symbol: entry.symbol, exchange: entry.exchange };
  }
  return null;
}

@ApiTags('Market Data')
@Controller('api/market-data')
export class MarketDataController {
  private readonly logger = new Logger(MarketDataController.name);

  constructor(
    private readonly marketFeedService: MarketFeedService,
    private readonly instrumentService: InstrumentService,
    private readonly candleAggregator: CandleAggregatorService,
    private readonly repository: MarketDataRepository,
    private readonly angelOneAdapter: AngelOneAdapterService,
  ) {}

  /**
   * GET /api/market-data/instruments
   * Search/list instruments with optional filters.
   */
  @Get('instruments')
  @ApiOperation({ summary: 'Search instruments' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'exchange', required: false })
  @ApiQuery({ name: 'segment', required: false })
  async getInstruments(
    @Query('search') search?: string,
    @Query('exchange') exchange?: string,
    @Query('segment') segment?: string,
  ) {
    try {
      if (!search || search.trim().length === 0) {
        // Return an empty set rather than all instruments
        return { instruments: [], count: 0 };
      }

      const trimmed = search.trim();

      // First search the local DB / in-memory cache
      const localResults = await this.instrumentService.search(
        trimmed,
        exchange,
        segment,
      );

      // If local results are sufficient, return them directly
      if (localResults.length >= 10) {
        return {
          instruments: localResults,
          count: localResults.length,
          source: 'local',
        };
      }

      // Fall back to Angel One searchScrip API for broader results.
      // Search across multiple exchanges unless a specific one was requested.
      const exchanges = exchange ? [exchange] : ['NSE', 'BSE', 'NFO', 'MCX'];
      const brokerResults: Array<{
        symbol: string;
        token: string;
        name: string;
        exchange: string;
        segment: string;
        lotSize: number;
        tickSize: number;
        expiry: null;
        strike: null;
        optionType: null;
      }> = [];

      const seenTokens = new Set(localResults.map((r) => r.token));

      for (const exch of exchanges) {
        try {
          const raw = await this.angelOneAdapter.searchInstruments(
            trimmed,
            exch,
          );

          for (const item of raw) {
            const token = String(item.symboltoken ?? item.token ?? '');
            if (!token || seenTokens.has(token)) continue;
            seenTokens.add(token);

            brokerResults.push({
              symbol: String(item.tradingsymbol ?? item.symbol ?? ''),
              token,
              name: String(item.symbolname ?? item.name ?? item.tradingsymbol ?? ''),
              exchange: String(item.exchange ?? exch),
              segment: String(item.exch_seg ?? exch),
              lotSize: parseInt(String(item.lotsize ?? '1')) || 1,
              tickSize: parseFloat(String(item.tick_size ?? '0.05')) || 0.05,
              expiry: null,
              strike: null,
              optionType: null,
            });
          }
        } catch (err) {
          this.logger.warn(
            `Angel One search on ${exch} failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      const combined = [...localResults, ...brokerResults].slice(0, 50);

      return {
        instruments: combined,
        count: combined.length,
        source: brokerResults.length > 0 ? 'local+angel_one' : 'local',
      };
    } catch (error) {
      this.logger.error(
        `Failed to search instruments: ${error instanceof Error ? error.message : error}`,
      );
      throw new HttpException(
        'Failed to search instruments',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/market-data/instruments/:token/candles
   * Get historical candles for an instrument.
   */
  @Get('instruments/:token/candles')
  @ApiOperation({ summary: 'Get historical candles for an instrument' })
  @ApiParam({ name: 'token', description: 'Instrument token' })
  async getCandles(
    @Param('token') token: string,
    @Query() query: GetCandlesQueryDto,
  ) {
    try {
      const instrument = await this.instrumentService.getByToken(token);

      const from = new Date(query.from);
      const to = new Date(query.to);

      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        throw new HttpException(
          'Invalid date format for from/to parameters',
          HttpStatus.BAD_REQUEST,
        );
      }

      // When the instrument exists in the DB, attempt the DB candle lookup first.
      if (instrument) {
        const dbCandles = await this.repository.getCandles(
          instrument.id,
          query.timeframe,
          from,
          to,
        );

        if (dbCandles.length > 0) {
          return {
            token,
            symbol: instrument.symbol,
            timeframe: query.timeframe,
            candles: dbCandles.map((c) => ({
              timestamp: c.timestamp,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: Number(c.volume),
            })),
            count: dbCandles.length,
            source: 'database',
          };
        }
      }

      // Determine which exchange and symbol to use for the Angel One API call.
      // Priority: query param > instrument record > constants lookup > default (NSE).
      const constantEntry = resolveTokenFromConstants(token);

      const exchange =
        query.exchange ??
        instrument?.exchange ??
        constantEntry?.exchange ??
        'NSE';

      const symbol = instrument?.symbol ?? constantEntry?.symbol ?? token;

      // Fetch from Angel One historical API (works for both known and unknown
      // instruments — e.g., MCX commodity tokens not yet in the local DB).
      this.logger.log(
        `Fetching candles from Angel One for token=${token} exchange=${exchange}` +
          (instrument ? '' : ' (instrument not in local DB)'),
      );

      const liveCandles = await this.angelOneAdapter.getHistoricalData(
        token,
        exchange,
        query.timeframe,
        from,
        to,
      );

      return {
        token,
        symbol,
        timeframe: query.timeframe,
        candles: liveCandles.map((c) => ({
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: Number(c.volume),
        })),
        count: liveCandles.length,
        source: 'angel_one',
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Failed to get candles for ${token}: ${error instanceof Error ? error.message : error}`,
      );
      throw new HttpException(
        'Failed to retrieve candles',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/market-data/instruments/:token/quote
   * Get the latest live quote for an instrument.
   */
  @Get('instruments/:token/quote')
  @ApiOperation({ summary: 'Get latest quote for an instrument' })
  @ApiParam({ name: 'token', description: 'Instrument token' })
  async getQuote(@Param('token') token: string) {
    const quote = this.marketFeedService.getQuote(token);

    if (!quote) {
      // Try to get instrument info even if no live quote is available
      const instrument = await this.instrumentService.getByToken(token);
      if (!instrument) {
        throw new HttpException(
          `Instrument not found for token: ${token}`,
          HttpStatus.NOT_FOUND,
        );
      }

      return {
        token,
        symbol: instrument.symbol,
        quote: null,
        message: 'No live quote available. Token may not be subscribed to the feed.',
      };
    }

    return { token, quote };
  }

  /**
   * GET /api/market-data/instruments/:token/oi
   * Get OI history for an instrument.
   */
  @Get('instruments/:token/oi')
  @ApiOperation({ summary: 'Get OI history for an instrument' })
  @ApiParam({ name: 'token', description: 'Instrument token' })
  async getOIHistory(
    @Param('token') token: string,
    @Query() query: GetOIQueryDto,
  ) {
    try {
      const instrument = await this.instrumentService.getByToken(token);
      if (!instrument) {
        return { token, symbol: '', oiHistory: [], count: 0 };
      }

      // Default to last 24 hours if no range specified
      const now = new Date();
      const from = query.from ? new Date(query.from) : new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const to = query.to ? new Date(query.to) : now;

      const oiHistory = await this.repository.getOIHistory(
        instrument.id,
        from,
        to,
      );

      return {
        token,
        symbol: instrument.symbol,
        oiHistory: oiHistory.map((snap) => ({
          oi: Number(snap.oi),
          oiChange: Number(snap.oiChange),
          volume: Number(snap.volume),
          timestamp: snap.timestamp,
        })),
        count: oiHistory.length,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Failed to get OI history for ${token}: ${error instanceof Error ? error.message : error}`,
      );
      throw new HttpException(
        'Failed to retrieve OI history',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/market-data/indices
   * Get all major indices with live data.
   */
  @Get('indices')
  @ApiOperation({ summary: 'Get major market indices with live data' })
  async getIndices() {
    const indices = this.instrumentService.getIndices();

    return {
      indices: indices.map((idx) => ({
        key: idx.key,
        symbol: idx.symbol,
        token: idx.token,
        exchange: idx.exchange,
        quote: this.marketFeedService.getQuote(idx.token),
      })),
    };
  }

  /**
   * GET /api/market-data/breadth
   * Get market breadth (advances, declines, unchanged) from cached quotes.
   */
  @Get('breadth')
  @ApiOperation({ summary: 'Get market breadth from cached quotes' })
  getBreadth() {
    return this.marketFeedService.getBreadth();
  }

  /**
   * GET /api/market-data/sector-performance
   * Get sector index performance from cached quotes.
   */
  @Get('sector-performance')
  @ApiOperation({ summary: 'Get sector index performance' })
  getSectorPerformance() {
    return {
      sectors: this.marketFeedService.getSectorPerformance(),
    };
  }

  /**
   * POST /api/market-data/watchlist/subscribe
   * Subscribe tokens to the live market data feed.
   */
  @Post('watchlist/subscribe')
  @ApiOperation({ summary: 'Subscribe tokens to the live feed' })
  async subscribeFeed(@Body() dto: SubscribeDto) {
    try {
      const subscribed = await this.marketFeedService.subscribe(dto.tokens);

      return {
        subscribed,
        count: subscribed.length,
        message:
          subscribed.length < dto.tokens.length
            ? `Subscribed ${subscribed.length}/${dto.tokens.length} tokens. Some may already be subscribed or slot limit reached.`
            : `Successfully subscribed ${subscribed.length} tokens.`,
      };
    } catch (error) {
      this.logger.error(
        `Failed to subscribe tokens: ${error instanceof Error ? error.message : error}`,
      );
      throw new HttpException(
        'Failed to subscribe to feed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/market-data/watchlist/unsubscribe
   * Unsubscribe tokens from the live feed.
   */
  @Post('watchlist/unsubscribe')
  @ApiOperation({ summary: 'Unsubscribe tokens from the live feed' })
  async unsubscribeFeed(@Body() dto: UnsubscribeDto) {
    try {
      const unsubscribed = await this.marketFeedService.unsubscribe(dto.tokens);

      return {
        unsubscribed,
        count: unsubscribed.length,
      };
    } catch (error) {
      this.logger.error(
        `Failed to unsubscribe tokens: ${error instanceof Error ? error.message : error}`,
      );
      throw new HttpException(
        'Failed to unsubscribe from feed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/market-data/feed/start
   * Manually start the market data feed.
   * Tries WebSocket first, falls back to REST polling (5s interval).
   */
  @Post('feed/start')
  @ApiOperation({
    summary: 'Manually start market data feed (WebSocket or REST polling fallback)',
  })
  async startFeed() {
    try {
      const result = await this.marketFeedService.manualStartFeed();
      return result;
    } catch (error) {
      this.logger.error(
        `Failed to start feed: ${error instanceof Error ? error.message : error}`,
      );
      throw new HttpException(
        'Failed to start market data feed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/market-data/status
   * Get feed connection status and active subscription counts.
   */
  @Get('status')
  @ApiOperation({ summary: 'Get feed connection status' })
  getStatus() {
    return {
      ...this.marketFeedService.getStatus(),
      marketOpen: this.marketFeedService.isMarketOpen(),
    };
  }

  @Get('debug/subscribed')
  @ApiOperation({ summary: 'Debug: list all currently subscribed tokens' })
  getSubscribedTokens() {
    return { tokens: this.marketFeedService.getSubscribedTokens() };
  }
}
