export type LevelType =
  | 'PDH' | 'PDL'
  | 'ORH' | 'ORL'
  | 'VWAP'
  | 'ROUND'
  | 'VOL_STRIKE';

export type SetupType = 'BREAKOUT' | 'REVERSAL';

export type SetupGrade = 'A' | 'B' | 'C';

export type TimeOfDayWindow = 'morning-trend' | 'afternoon-trend';

export interface SetupContext {
  levelType: LevelType;
  setupType: SetupType;
  levelValue: number;
  grade: SetupGrade;

  entry: number;
  stoploss: number;
  target: number;

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
  expiryDayWarning?: boolean;
}
