import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { LevelBook, SeedSessionInput, TickInput } from '../types/level-book.types';
import { InstrumentService } from '../../market-data/services/instrument.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { BrokerAdapter } from '../../../common/interfaces/broker-adapter.interface';
import { TIMEFRAMES } from '@td/shared/constants';

// Use the literal injection token string instead of importing
// BROKER_ADAPTER_TOKEN from market-feed.service — that import creates
// a circular load order (market-feed imports LevelBookService for the
// live tick path, LevelBookService importing back through it crashes
// the watcher at boot). The string is the source of truth either way.
const BROKER_ADAPTER_TOKEN = 'BROKER_ADAPTER';

const STALE_THRESHOLD_MS = 60_000;
const LAZY_FRESH_MS = 5 * 60 * 1000;
const ATR_PERIOD = 14;
const DEFAULT_ROUND_STEP: Record<string, number> = {
  NIFTY: 50, BANKNIFTY: 100, FINNIFTY: 50, MIDCPNIFTY: 25,
};
const DEFAULT_FALLBACK_STEP = 50;

interface BookState extends LevelBook {
  /** Internal accumulators for VWAP. */
  cumPV: number;
  cumV: number;
}

@Injectable()
export class LevelBookService {
  private readonly logger = new Logger(LevelBookService.name);
  private readonly books = new Map<string, BookState>();
  /**
   * Tokens whose books are kept current by the live tick path
   * (seeded by the cron, then updated on every WS tick via
   * MarketFeedService.updateFromTick). For these, lazyLoad can return
   * the cached book without rebuilding from DB — the in-memory book
   * is fresher than any DB snapshot would be.
   */
  private readonly liveBooks = new Set<string>();

  constructor(
    @Optional() private readonly instrumentService?: InstrumentService,
    @Optional() private readonly marketDataRepository?: MarketDataRepository,
    @Optional() @Inject(BROKER_ADAPTER_TOKEN) private readonly brokerAdapter?: BrokerAdapter | null,
  ) {}

  /** Cron + boot path call this so lazyLoad knows to trust the in-memory book. */
  markAsLive(token: string): void {
    this.liveBooks.add(token);
  }

  /**
   * Replay the most-recent session's 5m candles into a freshly-seeded
   * book to populate VWAP / todayHigh / todayLow / OR. Without this, a
   * book seeded by the cron has correct PDH/PDL/ATR (from daily candles)
   * but VWAP=0 and todayH/L=0 until the first live tick — which during
   * overnight is hours away. This routine fills in the gap from DB.
   *
   * "Most-recent session" definition: if `now` is past today's open,
   * use today's session; otherwise (overnight gap) use yesterday's. So
   * a chart opened at 02:00 IST shows yesterday's session VWAP, and
   * one opened at 11:00 IST shows today's accumulating session VWAP.
   */
  async replaySessionToBook(token: string, exchange: string, instrumentId: string): Promise<void> {
    if (!this.marketDataRepository) return;

    const now = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    const isMcx = exchange === 'MCX';
    const openH = isMcx ? 9 : 9;
    const openM = isMcx ? 0 : 15;
    const todayOpenIst = new Date(Date.UTC(
      istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(),
      openH, openM, 0, 0,
    ));
    const todayOpenUtc = new Date(todayOpenIst.getTime() - istOffsetMs);
    const sessionStart = now.getTime() >= todayOpenUtc.getTime()
      ? todayOpenUtc
      : new Date(todayOpenUtc.getTime() - 24 * 3600 * 1000);

    const fiveMinRows = await this.marketDataRepository.getCandles(
      instrumentId, TIMEFRAMES.FIVE_MIN, sessionStart, now,
    );

    if (fiveMinRows.length >= 3 && this.books.has(token)) {
      const orBars = fiveMinRows.slice(0, 3);
      const orHigh = Math.max(...orBars.map((b) => b.high));
      const orLow = Math.min(...orBars.map((b) => b.low));
      this.lockOpeningRange(token, { high: orHigh, low: orLow });
    }

    for (const bar of fiveMinRows) {
      this.updateFromTick({
        token,
        ltp: bar.close,
        volume: typeof bar.volume === 'bigint' ? Number(bar.volume) : bar.volume,
        timestamp: bar.timestamp,
      });
    }
  }

  seedSession(input: SeedSessionInput): void {
    const candles = [...input.recentDailyCandles].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
    if (candles.length === 0) {
      this.logger.warn(`seedSession: no candles for ${input.symbol}, skipping`);
      return;
    }
    const last = candles[candles.length - 1];
    const atr14 = this.computeAtr(candles);

    const book: BookState = {
      token: input.token,
      symbol: input.symbol,
      exchange: input.exchange,
      asOf: new Date(),
      pdh: last.high,
      pdl: last.low,
      prevClose: last.close,
      orh: null,
      orl: null,
      orLocked: false,
      spot: 0,
      vwap: 0,
      todayHigh: 0,
      todayLow: 0,
      atr14,
      lastTickAt: new Date(0),
      roundNumbers: [],
      cumPV: 0,
      cumV: 0,
    };
    this.books.set(input.token, book);
  }

  updateFromTick(tick: TickInput): void {
    const book = this.books.get(tick.token);
    if (!book) return; // not seeded; ignore silently

    book.spot = tick.ltp;
    if (book.todayHigh === 0 || tick.ltp > book.todayHigh) book.todayHigh = tick.ltp;
    if (book.todayLow === 0 || tick.ltp < book.todayLow) book.todayLow = tick.ltp;

    if (tick.volume > 0) {
      book.cumPV += tick.ltp * tick.volume;
      book.cumV += tick.volume;
      book.vwap = book.cumPV / book.cumV;
    }

    book.lastTickAt = tick.timestamp;
    book.roundNumbers = this.computeRoundNumbers(book.symbol, tick.ltp);
  }

  lockOpeningRange(token: string, or: { high: number; low: number }): void {
    const book = this.books.get(token);
    if (!book) return;
    if (book.orLocked) return; // idempotent
    book.orh = or.high;
    book.orl = or.low;
    book.orLocked = true;
  }

  getLevels(token: string): LevelBook | null {
    const book = this.books.get(token);
    if (!book) return null;
    // Strip internal accumulators from the public view
    const { cumPV: _pv, cumV: _v, ...publicBook } = book;
    void _pv; void _v;
    return publicBook;
  }

  isStale(token: string): boolean {
    const book = this.books.get(token);
    if (!book) return true;
    return Date.now() - book.lastTickAt.getTime() > STALE_THRESHOLD_MS;
  }

  setTopVolStrikes(token: string, strikes: number[]): void {
    const book = this.books.get(token);
    if (!book) return;
    book.topVolStrikes = strikes;
  }

  async lazyLoad(
    token: string,
    exchange: string,
    symbol: string,
  ): Promise<LevelBook | null> {
    const cached = this.books.get(token);

    // Live-fed books (universe symbols updated by the WS tick path) are
    // always fresher than any DB rebuild — return them directly without
    // the LAZY_FRESH_MS staleness check. This makes the chart analysis
    // reflect tick-by-tick reality during market hours and retains the
    // in-session VWAP/today's-H-L through overnight (when the lazy-build
    // path would otherwise rebuild and reset them to 0 because the new
    // session hasn't started yet).
    if (cached && this.liveBooks.has(token)) {
      const { cumPV: _pv, cumV: _v, ...publicBook } = cached;
      void _pv; void _v;
      return publicBook;
    }

    // Non-live (lazy-built) books still use the 5-min TTL — the snapshot
    // they were built from is only as fresh as the DB at build time.
    if (cached && Date.now() - cached.lastTickAt.getTime() < LAZY_FRESH_MS) {
      const { cumPV: _pv, cumV: _v, ...publicBook } = cached;
      void _pv; void _v;
      return publicBook;
    }

    const now = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    const sessionOpenIst = new Date(
      Date.UTC(
        istNow.getUTCFullYear(),
        istNow.getUTCMonth(),
        istNow.getUTCDate(),
        9, 15, 0, 0,
      ),
    );
    const sessionOpen = new Date(sessionOpenIst.getTime() - istOffsetMs);

    // Resolve via DB when seeded (universe symbols), else fall through to
    // broker historical API. Either path produces a populated LevelBook.
    const instrument = this.instrumentService
      ? await this.instrumentService.getByToken(token)
      : null;

    let dailyCandles: Array<{
      timestamp: Date; open: number; high: number; low: number; close: number; volume: number;
    }> = [];

    if (instrument && this.marketDataRepository) {
      const dailyFrom = new Date(sessionOpen.getTime() - 21 * 24 * 60 * 60 * 1000);
      const dailyRows = await this.marketDataRepository.getCandles(
        instrument.id,
        TIMEFRAMES.DAILY,
        dailyFrom,
        sessionOpen,
      );
      dailyCandles = dailyRows
        .filter((c) => c.timestamp.getTime() < sessionOpen.getTime())
        .slice(-14)
        .map((c) => ({
          timestamp: c.timestamp,
          open: c.open, high: c.high, low: c.low, close: c.close,
          volume: typeof c.volume === 'bigint' ? Number(c.volume) : c.volume,
        }));
    }

    // Broker fallback — fires when the local DB doesn't have the symbol
    // (e.g. user searched a stock that isn't in the seeded universe) or
    // doesn't have enough daily candles for ATR.
    if (dailyCandles.length < 14 && this.brokerAdapter?.getHistoricalData) {
      try {
        const dailyFrom = new Date(sessionOpen.getTime() - 30 * 24 * 60 * 60 * 1000);
        const brokerDaily = await this.brokerAdapter.getHistoricalData(
          token, exchange, '1d', dailyFrom, sessionOpen,
        );
        dailyCandles = brokerDaily
          .filter((c: any) => new Date(c.timestamp).getTime() < sessionOpen.getTime())
          .slice(-14)
          .map((c: any) => ({
            timestamp: new Date(c.timestamp),
            open: Number(c.open), high: Number(c.high),
            low: Number(c.low), close: Number(c.close),
            volume: Number(c.volume) || 0,
          }));
        this.logger.log(
          `lazyLoad: broker fallback fetched ${dailyCandles.length} daily candles for ${symbol} (${exchange})`,
        );
      } catch (err) {
        this.logger.warn(
          `lazyLoad: broker daily fetch failed for ${symbol}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (dailyCandles.length < 14) {
      this.logger.debug(
        `lazyLoad: ${symbol} has only ${dailyCandles.length} daily candles, need 14`,
      );
      return null;
    }

    this.seedSession({ token, symbol, exchange, recentDailyCandles: dailyCandles });

    // 5m bars for today's session — DB first, broker fallback.
    let fiveMinBars: typeof dailyCandles = [];
    if (instrument && this.marketDataRepository) {
      const fiveMinRows = await this.marketDataRepository.getCandles(
        instrument.id, TIMEFRAMES.FIVE_MIN, sessionOpen, now,
      );
      fiveMinBars = fiveMinRows.map((c) => ({
        timestamp: c.timestamp,
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: typeof c.volume === 'bigint' ? Number(c.volume) : c.volume,
      }));
    }
    if (fiveMinBars.length === 0 && this.brokerAdapter?.getHistoricalData) {
      try {
        const broker5m = await this.brokerAdapter.getHistoricalData(
          token, exchange, '5m', sessionOpen, now,
        );
        fiveMinBars = broker5m.map((c: any) => ({
          timestamp: new Date(c.timestamp),
          open: Number(c.open), high: Number(c.high),
          low: Number(c.low), close: Number(c.close),
          volume: Number(c.volume) || 0,
        }));
      } catch (err) {
        this.logger.warn(
          `lazyLoad: broker 5m fetch failed for ${symbol}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (fiveMinBars.length >= 3) {
      const orBars = fiveMinBars.slice(0, 3);
      const orHigh = Math.max(...orBars.map((b) => b.high));
      const orLow = Math.min(...orBars.map((b) => b.low));
      this.lockOpeningRange(token, { high: orHigh, low: orLow });
    }

    for (const bar of fiveMinBars) {
      this.updateFromTick({
        token,
        ltp: bar.close,
        volume: bar.volume,
        timestamp: bar.timestamp,
      });
    }

    return this.getLevels(token);
  }

  /** Wilder-smoothed ATR over the last ATR_PERIOD candles. */
  private computeAtr(
    candles: SeedSessionInput['recentDailyCandles'],
  ): number {
    if (candles.length < 2) return 0;
    const window = candles.slice(-ATR_PERIOD - 1);
    const trs: number[] = [];
    for (let i = 1; i < window.length; i++) {
      const cur = window[i];
      const prev = window[i - 1];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close),
      );
      trs.push(tr);
    }
    if (trs.length === 0) return 0;
    // Simple SMA of TR over up to ATR_PERIOD bars (good enough; Wilder
    // smoothing converges to SMA over a stable series).
    const sum = trs.slice(-ATR_PERIOD).reduce((a, b) => a + b, 0);
    return sum / Math.min(ATR_PERIOD, trs.length);
  }

  private computeRoundNumbers(symbol: string, spot: number): number[] {
    const step = DEFAULT_ROUND_STEP[symbol.toUpperCase()] ?? DEFAULT_FALLBACK_STEP;
    const center = Math.round(spot / step) * step;
    return [center - 2 * step, center - step, center, center + step, center + 2 * step];
  }
}
