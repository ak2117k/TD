/**
 * Per-instrument level book maintained by LevelBookService.
 * See docs/superpowers/specs/2026-04-27-levels-context-strategy-design.md
 * §3.1 for design rationale.
 */
export interface LevelBook {
  token: string;
  symbol: string;
  exchange: string;
  asOf: Date;

  // Static — locked once per session
  pdh: number;
  pdl: number;
  prevClose: number;
  orh: number | null;
  orl: number | null;
  orLocked: boolean;

  // Dynamic — rolling on every tick
  spot: number;
  vwap: number;
  todayHigh: number;
  todayLow: number;
  /** 14-period DAILY ATR. Drives all distance gates and SL buffers. */
  atr14: number;
  /** Last tick timestamp; if older than 60s, level book is stale. */
  lastTickAt: Date;

  // Computed on demand
  roundNumbers: number[];
  topVolStrikes?: number[];
}

export interface SeedSessionInput {
  token: string;
  symbol: string;
  exchange: string;
  /** Sorted ascending by timestamp; service uses last 14 daily candles + previous day's H/L. */
  recentDailyCandles: Array<{
    timestamp: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
}

export interface TickInput {
  token: string;
  ltp: number;
  volume: number;
  timestamp: Date;
}
