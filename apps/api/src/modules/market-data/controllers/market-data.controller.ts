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
import {
  SubscribeDto,
  UnsubscribeDto,
  SearchInstrumentDto,
  GetCandlesQueryDto,
  GetOIQueryDto,
} from '../dto/market-data.dto';

@ApiTags('Market Data')
@Controller('api/market-data')
export class MarketDataController {
  private readonly logger = new Logger(MarketDataController.name);

  constructor(
    private readonly marketFeedService: MarketFeedService,
    private readonly instrumentService: InstrumentService,
    private readonly candleAggregator: CandleAggregatorService,
    private readonly repository: MarketDataRepository,
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

      const instruments = await this.instrumentService.search(
        search.trim(),
        exchange,
        segment,
      );

      return {
        instruments,
        count: instruments.length,
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
      if (!instrument) {
        throw new HttpException(
          `Instrument not found for token: ${token}`,
          HttpStatus.NOT_FOUND,
        );
      }

      const from = new Date(query.from);
      const to = new Date(query.to);

      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        throw new HttpException(
          'Invalid date format for from/to parameters',
          HttpStatus.BAD_REQUEST,
        );
      }

      const candles = await this.repository.getCandles(
        instrument.id,
        query.timeframe,
        from,
        to,
      );

      return {
        token,
        symbol: instrument.symbol,
        timeframe: query.timeframe,
        candles: candles.map((c) => ({
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: Number(c.volume),
        })),
        count: candles.length,
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
        throw new HttpException(
          `Instrument not found for token: ${token}`,
          HttpStatus.NOT_FOUND,
        );
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
   * GET /api/market-data/status
   * Get feed connection status and active subscription counts.
   */
  @Get('status')
  @ApiOperation({ summary: 'Get feed connection status' })
  getStatus() {
    return this.marketFeedService.getStatus();
  }
}
