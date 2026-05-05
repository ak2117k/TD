export type LevelType =
  | 'PDH' | 'PDL'
  | 'ORH' | 'ORL'
  | 'VWAP'
  | 'ROUND'
  | 'VOL_STRIKE'
  | 'STRONG_ZONE';

export type SetupType = 'BREAKOUT' | 'REVERSAL';

export type SetupGrade = 'A' | 'B' | 'C';

export type TimeOfDayWindow = 'morning-trend' | 'afternoon-trend';

/**
 * Daily regime classification — drives per-setup-type bias in gradeSetup
 * and the regime-mismatch reject gate. Computed once per analyze() call
 * from the LevelBook (todayHigh/todayLow vs atr14).
 */
export type Regime = 'trending' | 'choppy' | 'normal';

export interface IndicatorReadings {
  ema9: number | null;
  ema21: number | null;
  rsi14: number | null;
  macdHistogram: number | null;     // signed; positive = bullish
  bollingerPosition: number | null; // -1 to +1, where price sits relative to bands (0 = middle)
  roc10: number | null;             // percentage
  /** Per-indicator alignment with the setup direction: 1 = aligned, -1 = opposed, 0 = neutral. */
  alignment: {
    ema: 1 | 0 | -1;
    rsi: 1 | 0 | -1;
    macd: 1 | 0 | -1;
    bollinger: 1 | 0 | -1;
    momentum: 1 | 0 | -1;
  };
  /** Sum of alignment values (-5 to +5). For BUY, +5 means all bullish; for SELL, +5 means all bearish (alignment is computed in the SETUP direction). */
  agreement: number;
}

export interface SetupContext {
  levelType: LevelType;
  setupType: SetupType;
  levelValue: number;
  grade: SetupGrade;

  entry: number;
  stoploss: number;
  target: number;
  /** Price at which 50% of the position is booked (1×SL distance in profit). */
  partialTakeAt: number;

  triggerCandle: {
    time: number; // unix seconds
    ohlc: [number, number, number, number]; // open, high, low, close
  };

  levelBookSnapshot: {
    pdh: number;
    pdl: number;
    orh: number | null;
    orl: number | null;
    vwap: number;
    todayHigh: number;
    todayLow: number;
  };

  atr14: number;
  volumeRatio: number; // 5m volume / VMA20
  timeOfDayWindow: TimeOfDayWindow;
  indicators: IndicatorReadings;
  /**
   * Higher-timeframe trend bias snapshot used by the MTF gate. Computed by
   * SignalGeneratorService from the closed bar of the next-higher TF (e.g.
   * 1H when working on 15m). Null when the working TF has no defined
   * higher TF (e.g. 1d) or when not enough higher-TF candles were
   * available to compute it.
   */
  higherTimeframeTrend: {
    tf: string;
    ema9: number;
    ema21: number;
    bias: 'bullish' | 'bearish' | 'neutral';
  } | null;
  /**
   * Daily regime classification. Null when not computed (defensive — legacy
   * callers without LevelBook range/ATR data). Drives the per-setup-type
   * bias applied in gradeSetup() and the regime-mismatch reject gate.
   */
  regime: Regime | null;
  /** intradayRange / atr14 — diagnostic ratio backing the regime label. */
  intradayRangeRatio: number;
  expiryDayWarning?: boolean;
  /**
   * How TP1 (`partialTakeAt`) was placed:
   *   'fixed'    → entry ± 1×R (the historical default)
   *   'obstacle' → near edge of a STRONG/MEDIUM zone (touchCount ≥ 3) in
   *                the trade path, with a 0.1×ATR buffer.
   *
   * Optional so persisted setups from before this field existed still
   * rehydrate cleanly (Prisma column is `Json?`).
   */
  tp1Source?: 'obstacle' | 'fixed';
  /**
   * Metadata about the obstacle that drove TP1 placement, populated only
   * when `tp1Source === 'obstacle'`. Surfaces in the AnalysisPanel TP1 row
   * so the trader can see WHY TP1 sits where it does.
   */
  tp1Obstacle?: {
    classification: 'STRONG' | 'MEDIUM';
    touchCount: number;
    /** The band edge price hits FIRST in the trade direction (upper for SELL, lower for BUY). */
    nearEdge: number;
  } | null;
}
