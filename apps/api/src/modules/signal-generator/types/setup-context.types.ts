export type LevelType =
  | 'PDH' | 'PDL'
  | 'ORH' | 'ORL'
  | 'VWAP'
  | 'ROUND'
  | 'VOL_STRIKE';

export type SetupType = 'BREAKOUT' | 'REVERSAL';

export type SetupGrade = 'A' | 'B' | 'C';

export type TimeOfDayWindow = 'morning-trend' | 'afternoon-trend';

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
  expiryDayWarning?: boolean;
}
