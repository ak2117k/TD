import {
  TradingStrategy,
  MarketSnapshot,
  SignalOutput,
  CandleData,
  BacktestInput,
  BacktestResult,
} from '../../../common/interfaces/trading-strategy.interface';
import { LevelBook } from '../types/level-book.types';
import {
  LevelType,
  SetupType,
  SetupGrade,
  SetupContext,
  TimeOfDayWindow,
  IndicatorReadings,
} from '../types/setup-context.types';
import { ema, rsi, macd, bollinger, roc } from './indicators';

const DISTANCE_GATE_ATR = 0.3;       // |spot - level| ≤ 0.3 × ATR14
const BREAKOUT_BODY_ATR = 0.1;       // close must be > level + 0.1 × ATR
const VOLUME_RATIO_MIN = 1.2;        // 5m volume / VMA20
const PINBAR_BODY_PCT = 0.3;         // body ≤ 30% of full candle range
const SL_BUFFER_ATR = 0.25;          // SL = level + 0.25 × ATR (asymmetric direction-aware)
const RR_FLOOR_STRICT = 2.0;
const STALE_TICK_MS = 60_000;
// NSE opens at 09:15, MCX at 09:00. The morning window starts a settle
// period after the open so the first burst of opening volatility is
// already absorbed before the strategy starts evaluating setups.
// NSE: 30-min settle → 09:45. MCX: 15-min settle → 09:15.
const MORNING_START_NSE = '09:45';
const MORNING_START_MCX = '09:15';
const MORNING_END = '11:00';
const AFTERNOON_START = '14:30';
const AFTERNOON_END = '15:30';
const CONFLUENCE_RADIUS_ATR = 0.1;
const VOLUME_RATIO_GRADE_A = 1.4;

export interface AnalyzeInput {
  candles: CandleData[];
  levelBook: LevelBook;
  /** "HH:MM" 24h IST clock for the current scan tick. */
  nowIst: string;
  /**
   * Reference time in epoch-ms used by the staleness gate. Live mode omits
   * this — the strategy falls back to Date.now(). Backtest replays must
   * pass the replay-clock here (e.g. the bar's timestamp), otherwise the
   * staleness check would compare wall-clock against historical ticks and
   * bail every time.
   */
  nowMs?: number;
  /** Optional gate-trace callback for backtest harnesses. */
  debug?: (event: string, detail?: Record<string, unknown>) => void;
}

interface CandidateLevel {
  type: LevelType;
  value: number;
}

export class LevelsContextStrategy implements TradingStrategy {
  readonly name = 'levels-context';
  readonly description =
    'Intraday breakout/reversal scanner anchored on PDH/PDL/OR/VWAP/round-number levels with R:R + time-of-day + volume gates.';
  readonly supportedSegments = ['OPTIONS', 'EQUITY', 'FUTURES', 'COMMODITY'];
  readonly preferredTimeframes = ['5m'];

  private params: Record<string, unknown> = {
    rrFloor: RR_FLOOR_STRICT,
    distanceGateAtr: DISTANCE_GATE_ATR,
    volumeRatioMin: VOLUME_RATIO_MIN,
    // Live default is strict — only A/B grades go to the auto-trader.
    // Backtest harnesses can flip this to true to surface the ceiling
    // (what the strategy *would* trade if Grade C were allowed).
    includeGradeC: false,
  };

  // The TradingStrategy interface forces `analyze(MarketSnapshot)`. The
  // scanner wraps a LevelBook lookup into MarketSnapshot.metadata so we
  // accept either shape.
  analyze(data: MarketSnapshot | AnalyzeInput): SignalOutput | null {
    const input: AnalyzeInput | null = this.unwrap(data);
    if (!input) return null;
    const { candles, levelBook, nowIst, nowMs, debug } = input;

    if (candles.length < 25) { debug?.('reject:not-enough-candles'); return null; }
    if (this.isStale(levelBook, nowMs ?? Date.now())) { debug?.('reject:stale'); return null; }
    if (!this.inTradingWindow(nowIst, levelBook.exchange)) { debug?.('reject:outside-window', { nowIst, exchange: levelBook.exchange }); return null; }

    const last = candles[candles.length - 1];
    const vma20 = this.vma(candles.slice(-21, -1)); // 20 prior bars
    const volumeRatio = vma20 > 0 ? last.volume / vma20 : 0;
    debug?.('in-window', { atr14: levelBook.atr14, volumeRatio, spot: levelBook.spot });

    const candidates = this.collectLevels(levelBook);
    for (const lvl of candidates) {
      const dist = Math.abs(levelBook.spot - lvl.value);
      if (dist > DISTANCE_GATE_ATR * levelBook.atr14) {
        debug?.('reject:distance', { type: lvl.type, value: lvl.value, dist, gate: DISTANCE_GATE_ATR * levelBook.atr14 });
        continue;
      }
      debug?.('pass:distance', { type: lvl.type, value: lvl.value });

      const reversal = this.detectReversal(last, lvl, levelBook.atr14);
      const breakout = !reversal && this.detectBreakout(last, lvl, levelBook.atr14, volumeRatio, levelBook.spot);
      if (!breakout && !reversal) { debug?.('reject:confirmation', { type: lvl.type, volumeRatio }); continue; }
      debug?.('pass:confirmation', { type: lvl.type, kind: breakout ? 'BREAKOUT' : 'REVERSAL' });

      const setupType: SetupType = breakout ? 'BREAKOUT' : 'REVERSAL';
      const isLong = this.directionFromSetup(setupType, last, lvl.value);
      const slTarget = this.computeSlAndTarget({
        setupType, isLong, level: lvl.value, atr: levelBook.atr14,
        levelBook, candidates,
      });
      if (!slTarget) continue;

      const rr =
        Math.abs(slTarget.target - slTarget.entry) /
        Math.max(Math.abs(slTarget.entry - slTarget.stoploss), 1e-6);
      if (rr < (this.params.rrFloor as number)) { debug?.('reject:rr', { rr }); continue; }
      debug?.('pass:rr', { rr });

      const indicators = this.computeIndicators(candles, levelBook.spot, isLong);
      debug?.('pass:indicators', { agreement: indicators.agreement });

      const grade = this.gradeSetup({
        candidates, level: lvl, atr: levelBook.atr14,
        volumeRatio, nowIst, agreement: indicators.agreement,
        exchange: levelBook.exchange,
      });
      if (grade === 'C' && !this.params.includeGradeC) {
        debug?.('reject:grade-c', { volumeRatio, agreement: indicators.agreement });
        continue;
      }
      debug?.('pass:grade', { grade, agreement: indicators.agreement });

      const window: TimeOfDayWindow =
        this.between(nowIst, MORNING_START, MORNING_END)
          ? 'morning-trend' : 'afternoon-trend';

      const setupContext: SetupContext = {
        levelType: lvl.type,
        setupType,
        levelValue: lvl.value,
        grade,
        entry: slTarget.entry,
        stoploss: slTarget.stoploss,
        target: slTarget.target,
        triggerCandle: {
          time: Math.floor(last.timestamp.getTime() / 1000),
          ohlc: [last.open, last.high, last.low, last.close],
        },
        levelBookSnapshot: {
          pdh: levelBook.pdh, pdl: levelBook.pdl,
          orh: levelBook.orh, orl: levelBook.orl,
          vwap: levelBook.vwap,
          todayHigh: levelBook.todayHigh, todayLow: levelBook.todayLow,
        },
        atr14: levelBook.atr14,
        volumeRatio,
        timeOfDayWindow: window,
        indicators,
      };

      const reason = this.buildReason(setupContext, levelBook);

      return {
        symbol: levelBook.symbol,
        exchange: levelBook.exchange,
        side: isLong ? 'BUY' : 'SELL',
        entryPrice: slTarget.entry,
        targetPrice: slTarget.target,
        stoplossPrice: slTarget.stoploss,
        confidence: Math.round(rr * 25), // crude 0-100 from R:R
        reason,
        timeframe: '5m',
        metadata: setupContext,
      };
    }

    return null;
  }

  backtest(_input: BacktestInput): BacktestResult {
    // Backtesting is implemented in scripts/backtest-levels-context.mjs
    // which calls analyze() directly with replayed candle/level-book inputs.
    // The TradingStrategy interface requires this method — we throw to
    // signal callers to use the dedicated harness instead.
    throw new Error(
      'LevelsContextStrategy: use scripts/backtest-levels-context.mjs for backtesting.',
    );
  }

  getParameters(): Record<string, unknown> {
    return { ...this.params };
  }

  setParameters(params: Record<string, unknown>): void {
    this.params = { ...this.params, ...params };
  }

  // ─────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────

  private unwrap(data: MarketSnapshot | AnalyzeInput): AnalyzeInput | null {
    if ('levelBook' in data && 'nowIst' in data) {
      return data as AnalyzeInput;
    }
    const snapshot = data as MarketSnapshot;
    const meta = (snapshot as unknown as { metadata?: AnalyzeInput }).metadata;
    if (!meta || !meta.levelBook || !meta.nowIst) return null;
    return { candles: snapshot.candles, levelBook: meta.levelBook, nowIst: meta.nowIst };
  }

  private isStale(book: LevelBook, nowMs: number): boolean {
    return nowMs - book.lastTickAt.getTime() > STALE_TICK_MS;
  }

  private inTradingWindow(nowIst: string, exchange: string): boolean {
    const morningStart = exchange === 'MCX' ? MORNING_START_MCX : MORNING_START_NSE;
    return (
      this.between(nowIst, morningStart, MORNING_END) ||
      this.between(nowIst, AFTERNOON_START, AFTERNOON_END)
    );
  }

  private between(hhmm: string, lo: string, hi: string): boolean {
    return hhmm >= lo && hhmm <= hi;
  }

  private collectLevels(book: LevelBook): CandidateLevel[] {
    const out: CandidateLevel[] = [
      { type: 'PDH', value: book.pdh },
      { type: 'PDL', value: book.pdl },
      { type: 'VWAP', value: book.vwap },
    ];
    if (book.orh !== null) out.push({ type: 'ORH', value: book.orh });
    if (book.orl !== null) out.push({ type: 'ORL', value: book.orl });
    for (const r of book.roundNumbers) out.push({ type: 'ROUND', value: r });
    if (book.topVolStrikes) {
      for (const s of book.topVolStrikes) out.push({ type: 'VOL_STRIKE', value: s });
    }
    return out.filter((l) => Number.isFinite(l.value) && l.value > 0);
  }

  private detectBreakout(
    candle: CandleData,
    level: CandidateLevel,
    atr: number,
    volumeRatio: number,
    spot: number,
  ): boolean {
    if (Math.abs(spot - level.value) < 0.01) return false; // spot AT the level is not a breakout
    if (volumeRatio < VOLUME_RATIO_MIN) return false;
    const buffer = BREAKOUT_BODY_ATR * atr;
    const above = candle.close > level.value + buffer;
    const below = candle.close < level.value - buffer;
    return above || below;
  }

  private detectReversal(candle: CandleData, level: CandidateLevel, atr: number): boolean {
    const range = candle.high - candle.low;
    if (range <= 0) return false;
    const body = Math.abs(candle.close - candle.open);
    if (body / range > PINBAR_BODY_PCT) return false;

    // upper wick into a level above current (resistance rejection)
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const tagsLevelFromBelow = candle.high >= level.value && candle.close < level.value;
    const tagsLevelFromAbove = candle.low <= level.value && candle.close > level.value;
    if (tagsLevelFromBelow && upperWick / range > 0.5) return true;
    if (tagsLevelFromAbove && lowerWick / range > 0.5) return true;
    return false;
  }

  private directionFromSetup(
    setup: SetupType,
    last: CandleData,
    level: number,
  ): boolean {
    if (setup === 'BREAKOUT') return last.close > level;
    // REVERSAL: rejection at resistance (close < level) → SELL; bounce at support (close > level) → BUY
    return last.close > level;
  }

  private computeSlAndTarget(args: {
    setupType: SetupType;
    isLong: boolean;
    level: number;
    atr: number;
    levelBook: LevelBook;
    candidates: CandidateLevel[];
  }): { entry: number; stoploss: number; target: number } | null {
    const { setupType, isLong, level, atr, levelBook, candidates } = args;
    const buffer = SL_BUFFER_ATR * atr;
    const entry = levelBook.spot;
    let stoploss: number;

    if (setupType === 'BREAKOUT') {
      stoploss = isLong ? level - buffer : level + buffer;
    } else {
      stoploss = isLong ? level - buffer : level + buffer;
    }

    const slDist = Math.abs(entry - stoploss);
    if (slDist <= 0) return null;
    const minTargetDist = 2 * slDist;

    // Find the nearest opposing level in the trade direction
    const opposing = candidates
      .filter((c) => (isLong ? c.value > entry : c.value < entry))
      .sort((a, b) =>
        Math.abs(a.value - entry) - Math.abs(b.value - entry),
      );

    let target: number;
    if (opposing.length > 0 && Math.abs(opposing[0].value - entry) >= minTargetDist) {
      target = opposing[0].value;
    } else {
      target = isLong ? entry + minTargetDist : entry - minTargetDist;
    }
    return { entry, stoploss, target };
  }

  private gradeSetup(args: {
    candidates: CandidateLevel[];
    level: CandidateLevel;
    atr: number;
    volumeRatio: number;
    nowIst: string;
    agreement: number;
    exchange: string;
  }): SetupGrade {
    const { candidates, level, atr, volumeRatio, nowIst, agreement, exchange } = args;
    const confluence = candidates.filter(
      (c) =>
        c !== level && Math.abs(c.value - level.value) <= CONFLUENCE_RADIUS_ATR * atr,
    ).length;
    // Prime A-grade window: highest-quality post-open (after the settle)
    // and pre-close commit. NSE: 09:45-10:30 + 14:45-15:15.
    // MCX: 09:15-10:00 + 14:45-15:15 (same afternoon).
    const primeMorningStart = exchange === 'MCX' ? '09:15' : '09:45';
    const primeMorningEnd = exchange === 'MCX' ? '10:00' : '10:30';
    const primeWindow =
      this.between(nowIst, primeMorningStart, primeMorningEnd) ||
      this.between(nowIst, '14:45', '15:15');
    let base: SetupGrade;
    if (confluence >= 1 && volumeRatio >= VOLUME_RATIO_GRADE_A && primeWindow) base = 'A';
    else if (volumeRatio >= VOLUME_RATIO_MIN) base = 'B';
    else base = 'C';

    // Indicator-confluence adjustment: strong agreement (≥4) bumps up one
    // tier; meaningful opposition (≤-2) bumps down one tier; otherwise the
    // base grade stands.
    if (agreement >= 4) {
      if (base === 'B') return 'A';
      if (base === 'C') return 'B';
      return 'A';
    }
    if (agreement <= -2) {
      if (base === 'A') return 'B';
      if (base === 'B') return 'C';
      return 'C';
    }
    return base;
  }

  private computeIndicators(
    candles: CandleData[],
    spot: number,
    isLong: boolean,
  ): IndicatorReadings {
    const closes = candles.map((c) => c.close);
    const ema9Val = ema(closes, 9);
    const ema21Val = ema(closes, 21);
    const rsi14Val = rsi(closes, 14);
    const macdVal = macd(closes);
    const bb = bollinger(closes, 20, 2);
    const roc10Val = roc(closes, 10);

    const macdHistogram = macdVal ? macdVal.histogram : null;

    // Bollinger position normalised to [-1, +1] using `(spot - middle) /
    // (upper - middle)`. When upper === middle (zero-volatility window)
    // we report 0 to avoid div-by-zero.
    let bollingerPosition: number | null = null;
    if (bb) {
      const denom = bb.upper - bb.middle;
      if (denom > 0) {
        const raw = (spot - bb.middle) / denom;
        bollingerPosition = Math.max(-1, Math.min(1, raw));
      } else {
        bollingerPosition = 0;
      }
    }

    // Per-indicator bullish-vote (+1 bullish, -1 bearish, 0 neutral). For
    // SELL setups we flip at the end so "agrees with setup" stays +1.
    const emaVote: 1 | 0 | -1 =
      ema9Val == null || ema21Val == null ? 0 : ema9Val > ema21Val ? 1 : -1;

    let rsiVote: 1 | 0 | -1 = 0;
    if (rsi14Val != null) {
      // 50<rsi<70 = bullish trend zone; 30<rsi<50 = bearish trend zone.
      // Outside [30,70] is "stretched" → neutral (0) regardless of side.
      if (rsi14Val > 50 && rsi14Val < 70) rsiVote = 1;
      else if (rsi14Val > 30 && rsi14Val < 50) rsiVote = -1;
      else rsiVote = 0;
    }

    const macdVote: 1 | 0 | -1 =
      macdHistogram == null ? 0 : macdHistogram > 0 ? 1 : macdHistogram < 0 ? -1 : 0;

    const bbVote: 1 | 0 | -1 =
      bollingerPosition == null
        ? 0
        : bollingerPosition > 0
          ? 1
          : bollingerPosition < 0
            ? -1
            : 0;

    const momentumVote: 1 | 0 | -1 =
      roc10Val == null ? 0 : roc10Val > 0 ? 1 : roc10Val < 0 ? -1 : 0;

    const flip = (v: 1 | 0 | -1): 1 | 0 | -1 =>
      v === 1 ? -1 : v === -1 ? 1 : 0;
    const align = (v: 1 | 0 | -1): 1 | 0 | -1 => (isLong ? v : flip(v));

    const alignment = {
      ema: align(emaVote),
      rsi: align(rsiVote),
      macd: align(macdVote),
      bollinger: align(bbVote),
      momentum: align(momentumVote),
    };
    const agreement =
      alignment.ema +
      alignment.rsi +
      alignment.macd +
      alignment.bollinger +
      alignment.momentum;

    return {
      ema9: ema9Val,
      ema21: ema21Val,
      rsi14: rsi14Val,
      macdHistogram,
      bollingerPosition,
      roc10: roc10Val,
      alignment,
      agreement,
    };
  }

  private vma(candles: CandleData[]): number {
    if (candles.length === 0) return 0;
    const sum = candles.reduce((a, c) => a + c.volume, 0);
    return sum / candles.length;
  }

  private buildReason(ctx: SetupContext, book: LevelBook): string {
    const dir = ctx.setupType === 'BREAKOUT' ? 'broke' : 'rejected';
    return `${book.symbol} ${dir} ${ctx.levelType} (${ctx.levelValue}). Volume ${ctx.volumeRatio.toFixed(2)}× VMA20. SL ${ctx.stoploss.toFixed(2)}, target ${ctx.target.toFixed(2)}, R:R ${(Math.abs(ctx.target - ctx.entry) / Math.abs(ctx.entry - ctx.stoploss)).toFixed(2)}. Grade ${ctx.grade}.`;
  }
}
