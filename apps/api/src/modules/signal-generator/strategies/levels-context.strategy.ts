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
} from '../types/setup-context.types';

const DISTANCE_GATE_ATR = 0.3;       // |spot - level| ≤ 0.3 × ATR14
const BREAKOUT_BODY_ATR = 0.1;       // close must be > level + 0.1 × ATR
const VOLUME_RATIO_MIN = 1.2;        // 5m volume / VMA20
const PINBAR_BODY_PCT = 0.3;         // body ≤ 30% of full candle range
const SL_BUFFER_ATR = 0.25;          // SL = level + 0.25 × ATR (asymmetric direction-aware)
const RR_FLOOR_STRICT = 2.0;
const STALE_TICK_MS = 60_000;
const MORNING_START = '09:45';
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
  };

  // The TradingStrategy interface forces `analyze(MarketSnapshot)`. The
  // scanner wraps a LevelBook lookup into MarketSnapshot.metadata so we
  // accept either shape.
  analyze(data: MarketSnapshot | AnalyzeInput): SignalOutput | null {
    const input: AnalyzeInput | null = this.unwrap(data);
    if (!input) return null;
    const { candles, levelBook, nowIst } = input;

    if (candles.length < 25) return null;
    if (this.isStale(levelBook)) return null;
    if (!this.inTradingWindow(nowIst)) return null;

    const last = candles[candles.length - 1];
    const vma20 = this.vma(candles.slice(-21, -1)); // 20 prior bars
    const volumeRatio = vma20 > 0 ? last.volume / vma20 : 0;

    const candidates = this.collectLevels(levelBook);
    for (const lvl of candidates) {
      const dist = Math.abs(levelBook.spot - lvl.value);
      if (dist > DISTANCE_GATE_ATR * levelBook.atr14) continue;

      const reversal = this.detectReversal(last, lvl, levelBook.atr14);
      const breakout = !reversal && this.detectBreakout(last, lvl, levelBook.atr14, volumeRatio, levelBook.spot);
      if (!breakout && !reversal) continue;

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
      if (rr < (this.params.rrFloor as number)) continue;

      const grade = this.gradeSetup({
        candidates, level: lvl, atr: levelBook.atr14,
        volumeRatio, nowIst,
      });
      if (grade === 'C') continue; // C-grade filtered out at strict threshold

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

  private isStale(book: LevelBook): boolean {
    return Date.now() - book.lastTickAt.getTime() > STALE_TICK_MS;
  }

  private inTradingWindow(nowIst: string): boolean {
    return (
      this.between(nowIst, MORNING_START, MORNING_END) ||
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
  }): SetupGrade {
    const { candidates, level, atr, volumeRatio, nowIst } = args;
    const confluence = candidates.filter(
      (c) =>
        c !== level && Math.abs(c.value - level.value) <= CONFLUENCE_RADIUS_ATR * atr,
    ).length;
    const primeWindow =
      this.between(nowIst, '09:45', '10:30') ||
      this.between(nowIst, '14:45', '15:15');
    if (confluence >= 1 && volumeRatio >= VOLUME_RATIO_GRADE_A && primeWindow) return 'A';
    if (volumeRatio >= VOLUME_RATIO_MIN) return 'B';
    return 'C';
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
