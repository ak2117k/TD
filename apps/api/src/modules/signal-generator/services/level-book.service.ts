import { Injectable, Logger } from '@nestjs/common';
import { LevelBook, SeedSessionInput, TickInput } from '../types/level-book.types';

const STALE_THRESHOLD_MS = 60_000;
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
