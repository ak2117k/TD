// apps/api/src/modules/chartink/services/chartink-scoring.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { NseSectorIndexService } from '../../market-data/services/nse-sector-index.service';
import { ema, macd, atr, supertrend } from '../../signal-generator/strategies/indicators';

export type SetupSide = 'BUY' | 'SELL';

export interface ScoreCheckResult {
  name: string;
  points: number;
  pointsPossible: number;
  passed: boolean;
  detail?: Record<string, unknown>;
}

export interface ScoringInput {
  token: string;
  symbol: string;
  exchange: string;
  side: SetupSide;
  entryPrice: number;
  setupContext?: { levelBookSnapshot?: { pdh: number; pdl: number; orh: number | null; orl: number | null; vwap: number } } | null;
}

export interface ScoringResult {
  score: number;
  lotCount: 0 | 1 | 2 | 3;
  checks: ScoreCheckResult[];
}

const NIFTY_TOKEN = '99926000';
const NIFTY_EXCHANGE = 'NSE';

const LOT_BAND_THRESHOLDS = [50, 65, 80] as const;

@Injectable()
export class ChartinkScoringService {
  private readonly logger = new Logger(ChartinkScoringService.name);

  constructor(
    private readonly adapter: AngelOneAdapterService,
    private readonly nseSectors: NseSectorIndexService,
  ) {}

  /**
   * Score a Chartink setup against the 10-check table. Returns score 0-100
   * plus per-check breakdown. Never throws — failed checks return points=0
   * with detail.error.
   */
  async score(input: ScoringInput): Promise<ScoringResult> {
    const checks: ScoreCheckResult[] = [];

    // Reset the per-scoring-run candle cache. Each (token, exchange, tf) tuple
    // is fetched at most once per score() call — typical scoring run makes
    // 8-10 fetches with 3-4 duplicates (e.g. stock 15m used by Sector-RS,
    // Price-vs-EMA, and SuperTrend). Cache cuts to ~5-6 unique fetches.
    // Safe because Bull's chartink-process worker runs serially (concurrency=1).
    this.candleCache.clear();

    // Run checks sequentially to respect the 350ms broker rate-limit pacer.
    // Total worst case: 10 * 350ms = ~3.5s per setup. Acceptable for now.
    checks.push(await this.checkSectorAligned(input));
    await this.sleep(350);
    checks.push(await this.checkRelativeStrength(input));
    await this.sleep(350);
    checks.push(await this.checkIndexAligned(input));
    await this.sleep(350);
    checks.push(await this.checkMacdDaily(input));
    await this.sleep(350);
    checks.push(await this.checkMacdOneMin(input));
    await this.sleep(350);
    checks.push(await this.checkMacdFiveMin(input));
    await this.sleep(350);
    checks.push(await this.checkPriceVs20Ema(input));
    await this.sleep(350);
    checks.push(await this.checkSupertrend(input));
    await this.sleep(350);
    checks.push(await this.checkSrRoom(input));
    await this.sleep(350);
    checks.push(await this.checkVolume(input));

    const score = checks.reduce((sum, c) => sum + c.points, 0);
    const lotCount = this.scoreToLotCount(score);
    return { score, lotCount, checks };
  }

  scoreToLotCount(score: number): 0 | 1 | 2 | 3 {
    if (score < LOT_BAND_THRESHOLDS[0]) return 0;
    if (score < LOT_BAND_THRESHOLDS[1]) return 1;
    if (score < LOT_BAND_THRESHOLDS[2]) return 2;
    return 3;
  }

  // ─── Individual checks ──────────────────────────────────────────────────

  private async checkSectorAligned(input: ScoringInput): Promise<ScoreCheckResult> {
    const name = 'Sector aligned';
    const pointsPossible = 10;
    const sectorToken = await this.nseSectors.getSectorIndexForSymbol(input.symbol);
    if (!sectorToken) {
      return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'no sector mapping' } };
    }
    try {
      const candles = await this.fetch15mCandles(sectorToken, 'NSE', 50);
      const closes = candles.map((c) => c.close);
      const trend = this.classifyTrend(closes);
      if (!trend) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient sector candles' } };
      }
      const expected = input.side === 'BUY' ? 'UP' : 'DOWN';
      const passed = trend.direction === expected;
      return {
        name, points: passed ? pointsPossible : 0, pointsPossible, passed,
        detail: {
          sectorToken,
          sectorTrend: trend.direction,
          closeLast: trend.closeLast,
          emaNow: trend.emaNow,
          emaThen: trend.emaThen,
        },
      };
    } catch (err) {
      return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
    }
  }

  /**
   * Relative strength of stock vs its sector over 20 × 15m bars (~5 hours).
   *   stockReturn = (stock.close[now] - stock.close[then]) / stock.close[then]
   *   sectorReturn = same for sector
   *   RS = stockReturn - sectorReturn   (additive RS, in fractional units)
   *
   * BUY passes if RS > 0 (stock outperforming sector).
   * SELL passes if RS < 0 (stock underperforming sector).
   */
  private async checkRelativeStrength(input: ScoringInput): Promise<ScoreCheckResult> {
    const name = 'Relative strength';
    const pointsPossible = 10;
    const sectorToken = await this.nseSectors.getSectorIndexForSymbol(input.symbol);
    if (!sectorToken) {
      return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'no sector mapping' } };
    }
    try {
      const lookback = 20; // bars
      const stockCandles = await this.fetch15mCandles(input.token, input.exchange, lookback + 2);
      const sectorCandles = await this.fetch15mCandles(sectorToken, 'NSE', lookback + 2);
      if (stockCandles.length < lookback || sectorCandles.length < lookback) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient candles' } };
      }
      const sNow = stockCandles[stockCandles.length - 1].close;
      const sThen = stockCandles[stockCandles.length - lookback].close;
      const iNow = sectorCandles[sectorCandles.length - 1].close;
      const iThen = sectorCandles[sectorCandles.length - lookback].close;
      if (sThen === 0 || iThen === 0) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'zero baseline' } };
      }
      const stockReturn = (sNow - sThen) / sThen;
      const sectorReturn = (iNow - iThen) / iThen;
      const rs = stockReturn - sectorReturn;
      const passed = input.side === 'BUY' ? rs > 0 : rs < 0;
      return {
        name, points: passed ? pointsPossible : 0, pointsPossible, passed,
        detail: {
          stockReturn: +(stockReturn * 100).toFixed(2),
          sectorReturn: +(sectorReturn * 100).toFixed(2),
          rs: +(rs * 100).toFixed(2),
          lookbackBars: lookback,
        },
      };
    } catch (err) {
      return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
    }
  }

  private async checkIndexAligned(input: ScoringInput): Promise<ScoreCheckResult> {
    const name = 'Index aligned';
    const pointsPossible = 20;
    if (input.token === NIFTY_TOKEN) {
      return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'setup is on the index itself' } };
    }
    try {
      const candles = await this.fetch15mCandles(NIFTY_TOKEN, NIFTY_EXCHANGE, 50);
      const closes = candles.map((c) => c.close);
      const trend = this.classifyTrend(closes);
      if (!trend) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient nifty candles' } };
      }
      const expected = input.side === 'BUY' ? 'UP' : 'DOWN';
      const passed = trend.direction === expected;
      return {
        name, points: passed ? pointsPossible : 0, pointsPossible, passed,
        detail: {
          niftyTrend: trend.direction,
          closeLast: trend.closeLast,
          emaNow: trend.emaNow,
          emaThen: trend.emaThen,
        },
      };
    } catch (err) {
      return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
    }
  }

  private async checkMacdAtTf(
    input: ScoringInput, tf: '1d' | '1m' | '5m', pointsPossible: number, lookback: number,
  ): Promise<ScoreCheckResult> {
    const name = `MACD on ${tf}`;
    try {
      const candles = await this.fetchCandles(input.token, input.exchange, tf, lookback);
      if (candles.length < 35) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient candles' } };
      }
      const closes = candles.map((c) => c.close);
      const m = macd(closes);
      if (!m || m.macd === null || m.signal === null) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'macd null' } };
      }
      const passed = input.side === 'BUY' ? m.macd > m.signal : m.macd < m.signal;
      return {
        name, points: passed ? pointsPossible : 0, pointsPossible, passed,
        detail: { macd: m.macd, signal: m.signal },
      };
    } catch (err) {
      return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
    }
  }

  private checkMacdDaily(input: ScoringInput) { return this.checkMacdAtTf(input, '1d', 10, 50); }
  private checkMacdOneMin(input: ScoringInput) { return this.checkMacdAtTf(input, '1m', 7, 60); }
  private checkMacdFiveMin(input: ScoringInput) { return this.checkMacdAtTf(input, '5m', 8, 60); }

  private async checkPriceVs20Ema(input: ScoringInput): Promise<ScoreCheckResult> {
    const name = 'Price vs 20-EMA';
    const pointsPossible = 10;
    try {
      const candles = await this.fetch15mCandles(input.token, input.exchange, 50);
      const closes = candles.map((c) => c.close);
      const trend = this.classifyTrend(closes);
      if (!trend) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient candles' } };
      }
      const expected = input.side === 'BUY' ? 'UP' : 'DOWN';
      const passed = trend.direction === expected;
      return {
        name, points: passed ? pointsPossible : 0, pointsPossible, passed,
        detail: {
          trend: trend.direction,
          closeLast: trend.closeLast,
          emaNow: trend.emaNow,
          emaThen: trend.emaThen,
        },
      };
    } catch (err) {
      return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
    }
  }

  private async checkSupertrend(input: ScoringInput): Promise<ScoreCheckResult> {
    const name = 'SuperTrend match';
    const pointsPossible = 10;
    try {
      const candles = await this.fetch15mCandles(input.token, input.exchange, 50);
      if (candles.length < 11) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient candles' } };
      }
      const highs = candles.map((c) => c.high);
      const lows = candles.map((c) => c.low);
      const closes = candles.map((c) => c.close);
      const st = supertrend(highs, lows, closes, 10, 3);
      if (!st) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'supertrend null' } };
      }
      const passed = input.side === 'BUY' ? st.direction === 'UP' : st.direction === 'DOWN';
      return { name, points: passed ? pointsPossible : 0, pointsPossible, passed, detail: { value: st.value, direction: st.direction } };
    } catch (err) {
      return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
    }
  }

  private async checkSrRoom(input: ScoringInput): Promise<ScoreCheckResult> {
    const name = 'S/R room';
    const pointsPossible = 10;
    const lb = input.setupContext?.levelBookSnapshot;
    if (!lb) {
      return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'no level book' } };
    }
    try {
      const candles = await this.fetch15mCandles(input.token, input.exchange, 50);
      if (candles.length < 21) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient candles for ATR' } };
      }
      const highs = candles.map((c) => c.high);
      const lows = candles.map((c) => c.low);
      const closes = candles.map((c) => c.close);
      const atr20 = atr(highs, lows, closes, 20);
      if (atr20 === null || atr20 <= 0) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'atr null/zero' } };
      }
      // Find nearest opposing S/R
      let nextBlocker: number | null = null;
      if (input.side === 'BUY') {
        const candidates = [lb.pdh, lb.orh].filter((x): x is number => typeof x === 'number' && x > input.entryPrice);
        nextBlocker = candidates.length > 0 ? Math.min(...candidates) : null;
      } else {
        const candidates = [lb.pdl, lb.orl].filter((x): x is number => typeof x === 'number' && x < input.entryPrice);
        nextBlocker = candidates.length > 0 ? Math.max(...candidates) : null;
      }
      if (nextBlocker === null) {
        return { name, points: pointsPossible, pointsPossible, passed: true, detail: { reason: 'no opposing S/R within snapshot — full room' } };
      }
      const room = Math.abs(nextBlocker - input.entryPrice);
      const ratio = room / atr20;
      const passed = ratio >= 0.4;
      return { name, points: passed ? pointsPossible : 0, pointsPossible, passed, detail: { entryPrice: input.entryPrice, nextBlocker, atr20, ratio } };
    } catch (err) {
      return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
    }
  }

  private async checkVolume(input: ScoringInput): Promise<ScoreCheckResult> {
    const name = 'Volume confirmation';
    const pointsPossible = 5;
    try {
      const todayCandles = await this.fetchCandles(input.token, input.exchange, '5m', 100);
      const dailyCandles = await this.fetchCandles(input.token, input.exchange, '1d', 25);
      if (dailyCandles.length < 20) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient daily candles' } };
      }
      const todayVol = todayCandles.reduce((sum, c) => sum + (c.volume || 0), 0);
      const avgDaily = dailyCandles.slice(-20).reduce((s, c) => s + (c.volume || 0), 0) / 20;
      if (avgDaily === 0) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'avg daily volume zero' } };
      }
      const ratio = todayVol / avgDaily;
      const passed = ratio > 1.2;
      return { name, points: passed ? pointsPossible : 0, pointsPossible, passed, detail: { todayVol, avgDaily, ratio } };
    } catch (err) {
      return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  /**
   * Robust trend check: returns 'UP' / 'DOWN' / 'INDETERMINATE'.
   * Delegates to the exported free function so callers outside this class
   * (e.g. ChartinkProcessService sector gate) can share the same logic.
   */
  private classifyTrend(closes: number[]): {
    direction: 'UP' | 'DOWN' | 'INDETERMINATE';
    closeLast: number;
    emaNow: number | null;
    emaThen: number | null;
  } | null {
    return classifyTrendFull(closes);
  }

  /**
   * Per-scoring-run candle cache. Keyed by (token, exchange, tf). Stores
   * the in-flight Promise + the lookback size we fetched at — so a second
   * caller asking for a smaller lookback can serve from the same fetch.
   * Cleared at the start of each score() call.
   */
  private candleCache = new Map<string, { lookback: number; promise: Promise<Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number }>> }>();

  private async fetchCandles(token: string, exchange: string, tf: string, lookback: number): Promise<Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number }>> {
    const key = `${token}:${exchange}:${tf}`;
    const cached = this.candleCache.get(key);
    if (cached && cached.lookback >= lookback) {
      // Cached fetch was at least as large — slice the tail to the requested size.
      const candles = await cached.promise;
      return candles.slice(-lookback);
    }
    // Either no cache or cached lookback is smaller. Fetch fresh, sized to the
    // larger of the two. The next caller for either size serves from cache.
    const targetLookback = Math.max(lookback, cached?.lookback ?? 0);
    const promise = this.fetchCandlesUncached(token, exchange, tf, targetLookback);
    this.candleCache.set(key, { lookback: targetLookback, promise });
    const candles = await promise;
    return candles.slice(-lookback);
  }

  private async fetchCandlesUncached(token: string, exchange: string, tf: string, lookback: number): Promise<Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number }>> {
    const lookbackMs = this.lookbackMsForTf(tf, lookback);
    const to = new Date();
    const from = new Date(to.getTime() - lookbackMs);
    const candles = (await this.adapter.getHistoricalData(token, exchange, tf, from, to)) as any[];
    return candles.map((c) => ({
      timestamp: c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume) || 0,
    }));
  }

  private fetch15mCandles(token: string, exchange: string, n: number) {
    return this.fetchCandles(token, exchange, '15m', n);
  }

  private lookbackMsForTf(tf: string, count: number): number {
    // Every NSE-listed stock has months/years of history; the only reason we
    // ever get < N bars back is weekends + holidays + the occasional rate-
    // limit hiccup eating into our window. The OLD "bars × duration × 3"
    // formula was too tight — for 50 × 15m it asked for just 37.5 hours,
    // which fails over a long weekend or a holiday week.
    //
    // Switch to calendar-day generosity per timeframe. The chunker + per-
    // scoring-run cache make wider fetches cheap (1 chunk per trading day,
    // paced 350ms apart, results cached across all checks in one scoring
    // run). The trade is ~1-3s extra per scoring call for reliability —
    // worth it for "no compromise on data" semantics.
    //
    // Sizing rules:
    //   - 1 trading day ≈ 25 × 15m bars, 75 × 5m, 375 × 1m, 7 × 1h
    //   - Pad with +3 calendar days for weekend/holiday cushion
    //   - Floors guarantee minimums even when count is tiny
    const calendarDays: Record<string, number> = {
      '1m':  Math.max(2, Math.ceil(count / 375) * 2 + 1),
      '5m':  Math.max(2, Math.ceil(count / 75) * 2 + 1),
      '15m': Math.max(5, Math.ceil(count / 25) * 2 + 3),
      '1h':  Math.max(7, Math.ceil(count / 7) * 2 + 3),
      '1d':  Math.max(60, count * 2 + 30),
    };
    const days = calendarDays[tf] ?? 7;
    return days * 24 * 60 * 60 * 1000;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Exported free function: robust EMA-based trend classifier.
 *   - UP   requires: close > EMA20 AND EMA20[now] > EMA20[5 bars ago]
 *   - DOWN requires: close < EMA20 AND EMA20[now] < EMA20[5 bars ago]
 *   - INDETERMINATE: anything else (wandering EMA or price at EMA)
 * Returns null when there are insufficient candles (< 26 bars).
 * Used by ChartinkProcessService's sector hard gate as well as internally.
 */
export function classifyTrend(closes: number[]): 'UP' | 'DOWN' | 'INDETERMINATE' | null {
  const full = classifyTrendFull(closes);
  return full ? full.direction : null;
}

function classifyTrendFull(closes: number[]): {
  direction: 'UP' | 'DOWN' | 'INDETERMINATE';
  closeLast: number;
  emaNow: number | null;
  emaThen: number | null;
} | null {
  if (closes.length < 26) return null; // need 20 for EMA + 5 lookback + buffer
  const emaNow = ema(closes, 20);
  const emaThen = ema(closes.slice(0, -5), 20);
  if (emaNow === null || emaThen === null) return null;
  const closeLast = closes[closes.length - 1];
  if (closeLast > emaNow && emaNow > emaThen) {
    return { direction: 'UP', closeLast, emaNow, emaThen };
  }
  if (closeLast < emaNow && emaNow < emaThen) {
    return { direction: 'DOWN', closeLast, emaNow, emaThen };
  }
  return { direction: 'INDETERMINATE', closeLast, emaNow, emaThen };
}
