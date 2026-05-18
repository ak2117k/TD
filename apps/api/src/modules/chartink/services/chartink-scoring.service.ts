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

/**
 * Read-only candle store for backtest replay. A caller pre-fetches every
 * historical series ONCE (via `ChartinkScoringService.prefetch`) and hands
 * the resulting source to `score()` via `ScoringInput.candleSource`. Each
 * `score()` then reads candles from this in-memory store instead of hitting
 * the rate-limited broker — turning a ~25-bar backtest from N×6 broker
 * fetches into 6 total.
 */
export interface ScoringCandleSource {
  /**
   * Pre-fetched candles for (token, exchange, timeframe) with
   * timestamp <= asOf, chronological. Returns [] if the source holds
   * nothing for that series.
   */
  getCandles(token: string, exchange: string, timeframe: string, asOf: Date):
    Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number }>;
}

export interface ScoringInput {
  token: string;
  symbol: string;
  exchange: string;
  side: SetupSide;
  entryPrice: number;
  setupContext?: { levelBookSnapshot?: { pdh: number; pdl: number; orh: number | null; orl: number | null; vwap: number } } | null;
  /**
   * Optional "as of" timestamp for backtest replay. When set, EVERY
   * historical-candle fetch ends at this instant instead of "now" — so the
   * 10-check scoring sees only data that existed at `asOf`. When omitted,
   * behaviour is byte-identical to live scoring (windows end at `new Date()`).
   */
  asOf?: Date;
  /**
   * Optional pre-fetched candle store (see `ScoringCandleSource` /
   * `prefetch`). When set, every check reads candles from this store
   * instead of the broker — a pure data-access optimisation that MUST
   * produce a result identical to a live fetch of the same candles.
   * When omitted, behaviour is byte-identical to today (broker fetch).
   */
  candleSource?: ScoringCandleSource;
}

export interface ScoringResult {
  score: number;
  lotCount: 0 | 1 | 2 | 3;
  checks: ScoreCheckResult[];
  /**
   * True when the score is unreliable because broker candle data was
   * missing/insufficient (throttled fetches, empty responses, not-yet-
   * converged windows) rather than genuine signal failure. Set when 3+
   * checks failed for a data-availability reason. CONTRACT: consumers
   * (e.g. the watch monitor) use this to suppress false-stops — a
   * data-starved low score must NOT be treated as a real "score cratered".
   */
  dataStarved: boolean;
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
    const dataStarved = this.isDataStarved(checks);
    return { score, lotCount, checks, dataStarved };
  }

  /**
   * Pre-fetch — ONCE each — every historical candle series the 10 checks
   * consume, and return an in-memory {@link ScoringCandleSource} the caller
   * hands to subsequent `score({ candleSource })` calls.
   *
   * Motivation: a backtest re-scores ~25 bars; without prefetch each
   * `score()` re-fetches the same ~6 rate-limited series → ~9 minutes. With
   * prefetch the caller fetches 6 series once, then every `score()` reads
   * from memory.
   *
   * Series fetched: the stock's 1m / 5m / 15m / 1d, NIFTY 15m, and the
   * stock's sector-index 15m (skipped when the symbol has no sector
   * mapping). Each series is fetched over `[from - warmup, to]` where the
   * warmup is sized — via the existing `lookbackMsForTf` helper — to the
   * LARGEST lookback that timeframe's checks need, so scoring at `from`
   * still has full history (1m≥500, 5m≥350, 15m≥50, 1d≥300 bars).
   *
   * CONTRACT: prefetch fetches via the same `getHistoricalData` source as a
   * live `score()`, so a `score()` served from the returned source produces
   * a result identical to a live `score()` over the same candles. This is a
   * pure data-access optimisation — scores/checks/dataStarved do not change.
   */
  async prefetch(token: string, symbol: string, exchange: string, from: Date, to: Date): Promise<ScoringCandleSource> {
    // (timeframe, largest-lookback) the checks consume — see checkMacd* /
    // checkVolume / the 15m checks. The warmup window for each series is
    // sized so scoring AT `from` still has this many bars of lookback.
    const STOCK_SERIES: Array<{ tf: string; lookback: number }> = [
      { tf: '1m', lookback: 500 }, // checkMacdOneMin
      { tf: '5m', lookback: 350 }, // checkMacdFiveMin (> checkVolume's 100)
      { tf: '15m', lookback: 50 }, // all 15m checks (RS uses 22)
      { tf: '1d', lookback: 300 }, // checkMacdDaily (> checkVolume's 25)
    ];

    const store = new Map<string, Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number }>>();

    // One fetch per (token, exchange, tf). The window starts `warmup` before
    // `from` so the earliest-scored bar still resolves its full lookback.
    const fetchInto = async (t: string, ex: string, tf: string, lookback: number): Promise<void> => {
      const warmupMs = this.lookbackMsForTf(tf, lookback);
      const windowFrom = new Date(from.getTime() - warmupMs);
      const candles = await this.fetchCandlesUncached(t, ex, tf, lookback, undefined, windowFrom, to);
      store.set(`${t}:${ex}:${tf}`, candles);
    };

    // Stock series across all four timeframes.
    for (const { tf, lookback } of STOCK_SERIES) {
      await fetchInto(token, exchange, tf, lookback);
    }
    // NIFTY 15m (index-aligned check).
    await fetchInto(NIFTY_TOKEN, NIFTY_EXCHANGE, '15m', 50);
    // Sector-index 15m (sector-aligned + relative-strength checks). Skip
    // entirely when the symbol has no sector mapping.
    const sectorToken = await this.nseSectors.getSectorIndexForSymbol(symbol);
    if (sectorToken) {
      await fetchInto(sectorToken, 'NSE', '15m', 50);
    }

    return {
      getCandles: (t: string, ex: string, tf: string, asOf: Date) => {
        const series = store.get(`${t}:${ex}:${tf}`);
        if (!series) return [];
        // Chronological subset with timestamp <= asOf. The stored series is
        // already chronological (broker order), so a filter preserves order.
        const cutoff = asOf.getTime();
        return series.filter((c) => c.timestamp.getTime() <= cutoff);
      },
    };
  }

  /**
   * A check is "data-starved" when it failed specifically because broker
   * candle data was missing/insufficient (empty response, not-yet-converged
   * window) or the broker throttled the fetch — as opposed to a genuine
   * signal failure (trend wrong, MACD red, etc).
   *
   * Detected via the check's `detail`:
   *   - `reason` containing "insufficient" / "candles" — the explicit
   *     insufficient-candles guards in the checks below.
   *   - `error` carrying the throttle marker from the adapter (task 2:
   *     AngelThrottleError) or a generic candle-fetch failure.
   */
  private static readonly DATA_STARVED_REASONS = [
    'insufficient candles',
    'insufficient sector candles',
    'insufficient nifty candles',
    'insufficient candles for atr',
    'insufficient daily candles',
  ];

  private isCheckDataStarved(c: ScoreCheckResult): boolean {
    if (c.passed) return false;
    const detail = c.detail ?? {};
    const reason = typeof detail.reason === 'string' ? detail.reason.toLowerCase() : '';
    if (reason && ChartinkScoringService.DATA_STARVED_REASONS.includes(reason)) {
      return true;
    }
    // Defensive: any reason that mentions insufficient candles.
    if (reason.includes('insufficient') && reason.includes('candle')) {
      return true;
    }
    const error = typeof detail.error === 'string' ? detail.error.toLowerCase() : '';
    if (error) {
      // Throttle error from the adapter (task 2) — name or message marker.
      if (error.includes('angelthrottle') || error.includes('throttl')) return true;
      if (error.includes('data:null')) return true;
    }
    return false;
  }

  /** dataStarved when 3 or more checks failed for data-availability reasons. */
  private isDataStarved(checks: ScoreCheckResult[]): boolean {
    const starved = checks.filter((c) => this.isCheckDataStarved(c)).length;
    return starved >= 3;
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
      const candles = await this.fetch15mCandles(sectorToken, 'NSE', 50, input.asOf, input.candleSource);
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
      const stockCandles = await this.fetch15mCandles(input.token, input.exchange, lookback + 2, input.asOf, input.candleSource);
      const sectorCandles = await this.fetch15mCandles(sectorToken, 'NSE', lookback + 2, input.asOf, input.candleSource);
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
      const candles = await this.fetch15mCandles(NIFTY_TOKEN, NIFTY_EXCHANGE, 50, input.asOf, input.candleSource);
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
      const candles = await this.fetchCandles(input.token, input.exchange, tf, lookback, input.asOf, input.candleSource);
      // MACD's 26-period EMA needs a long warmup before its seed residual
      // decays out. Below 120 bars the line is materially un-converged
      // (several percent off the true value) and diverges from broker
      // apps — treat it as insufficient rather than report a wrong number.
      if (candles.length < 120) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient candles' } };
      }
      const closes = candles.map((c) => c.close);
      const m = macd(closes);
      if (!m || m.macd === null || m.signal === null) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'macd null' } };
      }
      // Pass only when the histogram has the right colour AND the MACD line
      // is on the right side of the zero line:
      //   BUY  → green (macd > signal) AND macd > 0  (positive momentum)
      //   SELL → red   (macd < signal) AND macd < 0  (negative momentum)
      const aboveZero = m.macd > 0;
      const belowZero = m.macd < 0;
      const green = m.macd > m.signal; // histogram green
      const red = m.macd < m.signal;   // histogram red
      const passed = input.side === 'BUY'
        ? green && aboveZero
        : red && belowZero;
      return {
        name, points: passed ? pointsPossible : 0, pointsPossible, passed,
        detail: { macd: m.macd, signal: m.signal, aboveZero, belowZero },
      };
    } catch (err) {
      return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
    }
  }

  // Long warmup windows so MACD's 26-EMA seed residual fully decays out and
  // the line converges to what broker charts (Angel One / Groww / TradingView)
  // show — the broker loads the entire chart, so we fetch more history to
  // converge. Per-timeframe bar counts (1d→300, 1m→500, 5m→350) — see
  // checkMacdAtTf. macd() itself is correct, just starved on short windows.
  //
  // Point weights (1d→5, 5m→10, 1m→10) favour the intraday timeframes that
  // matter most for Chartink intraday setups; the daily MACD is a softer
  // confirmation. The three weights sum to 25, keeping the table at 100.
  private checkMacdDaily(input: ScoringInput) { return this.checkMacdAtTf(input, '1d', 5, 300); }
  private checkMacdOneMin(input: ScoringInput) { return this.checkMacdAtTf(input, '1m', 10, 500); }
  private checkMacdFiveMin(input: ScoringInput) { return this.checkMacdAtTf(input, '5m', 10, 350); }

  /**
   * Fast/slow EMA cross check on 15m candles. Compares the 9-EMA against the
   * 20-EMA: EMA9 above EMA20 means short-term momentum leads the medium-term
   * trend (this also covers the moment of a fresh upward cross).
   *   BUY  passes iff ema9 > ema20
   *   SELL passes iff ema9 < ema20
   * Name kept as 'Price vs 20-EMA' — the frontend factor columns key on it.
   */
  private async checkPriceVs20Ema(input: ScoringInput): Promise<ScoreCheckResult> {
    const name = 'Price vs 20-EMA';
    const pointsPossible = 10;
    try {
      const candles = await this.fetch15mCandles(input.token, input.exchange, 50, input.asOf, input.candleSource);
      const closes = candles.map((c) => c.close);
      const ema9 = ema(closes, 9);
      const ema20 = ema(closes, 20);
      if (ema9 === null || ema20 === null) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient candles' } };
      }
      const passed = input.side === 'BUY' ? ema9 > ema20 : ema9 < ema20;
      return {
        name, points: passed ? pointsPossible : 0, pointsPossible, passed,
        detail: {
          ema9: +ema9.toFixed(2),
          ema20: +ema20.toFixed(2),
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
      // SuperTrend is a recursive carrying-band indicator — its finalUpper/
      // finalLower bands and direction carry forward bar by bar, so a short
      // window starts cold and resolves the wrong direction on slow/quiet
      // trends (same warm-up class as the MACD-5m fix). Compute it on the 5m
      // timeframe with a 350-bar warm-up so the bands fully converge — the
      // same fetch shape checkMacdFiveMin uses.
      const candles = await this.fetchCandles(input.token, input.exchange, '5m', 350, input.asOf, input.candleSource);
      // supertrend(…, 10, 3) needs period+1 = 11 bars at the bare minimum,
      // but a cold short window gives the wrong direction. Require a real
      // warm-up — 120 bars decays the recursive bands to a stable answer.
      if (candles.length < 120) {
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
      const candles = await this.fetch15mCandles(input.token, input.exchange, 50, input.asOf, input.candleSource);
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
      const todayCandles = await this.fetchCandles(input.token, input.exchange, '5m', 100, input.asOf, input.candleSource);
      const dailyCandles = await this.fetchCandles(input.token, input.exchange, '1d', 25, input.asOf, input.candleSource);
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

  private async fetchCandles(token: string, exchange: string, tf: string, lookback: number, asOf?: Date, candleSource?: ScoringCandleSource): Promise<Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number }>> {
    // Pre-fetched-source path: when a candleSource is active, read the raw
    // candle array from it (already pre-fetched ONCE for the whole backtest)
    // instead of touching the broker. The SAME downstream handling — the
    // closed-only forming-bar drop, then slice(-lookback) — is applied so the
    // result is byte-identical to a live fetch of the same candles. The
    // per-run candleCache is bypassed: the source already IS the cache.
    if (candleSource) {
      // getCandles ends the series at `asOf` (or "now" when asOf is absent),
      // mirroring fetchCandlesUncached's `to = asOf ?? new Date()`.
      const asOfEffective = asOf ?? new Date();
      const fullCandles = candleSource.getCandles(token, exchange, tf, asOfEffective);
      return fullCandles.slice(0, -1).slice(-lookback);
    }
    const key = `${token}:${exchange}:${tf}`;
    const cached = this.candleCache.get(key);
    let fullCandles: Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number }>;
    if (cached && cached.lookback >= lookback) {
      // Cached fetch was at least as large — reuse its full array.
      fullCandles = await cached.promise;
    } else {
      // Either no cache or cached lookback is smaller. Fetch fresh, sized to
      // the larger of the two. The next caller for either size serves from
      // cache. The cache always stores the FULL fetched array (forming bar
      // included) — the closed-only drop happens only on the way out below.
      const targetLookback = Math.max(lookback, cached?.lookback ?? 0);
      const promise = this.fetchCandlesUncached(token, exchange, tf, targetLookback, asOf);
      this.candleCache.set(key, { lookback: targetLookback, promise });
      fullCandles = await promise;
    }
    // Closed-only candle policy: the newest candle returned by the broker is
    // the currently-forming (partial) bar. Broker charts (Angel One / Groww /
    // TradingView) compute indicators on CLOSED candles, so we drop the
    // forming bar before any check sees the data — making all 10 checks
    // consistent and removing a one-bar lookahead in backtest (`asOf`)
    // scoring. `slice(0, -1)` on a 0/1-element array yields [] — the checks
    // already treat [] as insufficient, so this is safe.
    return fullCandles.slice(0, -1).slice(-lookback);
  }

  private async fetchCandlesUncached(
    token: string,
    exchange: string,
    tf: string,
    lookback: number,
    asOf?: Date,
    // Explicit window override (used by `prefetch` to fetch a wide warmup
    // window once). When omitted, the window is derived from lookback/asOf
    // exactly as before — live scoring is byte-identical.
    fromOverride?: Date,
    toOverride?: Date,
  ): Promise<Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number }>> {
    const lookbackMs = this.lookbackMsForTf(tf, lookback);
    // For backtest replay, the window ends at `asOf`; otherwise at "now".
    const to = toOverride ?? asOf ?? new Date();
    const from = fromOverride ?? new Date(to.getTime() - lookbackMs);
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

  private fetch15mCandles(token: string, exchange: string, n: number, asOf?: Date, candleSource?: ScoringCandleSource) {
    return this.fetchCandles(token, exchange, '15m', n, asOf, candleSource);
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
