// Re-export all shared types
export type {
  Quote,
  Candle,
  OIData,
  OptionsChainEntry,
  OptionData,
  OrderRequest,
  Position,
  PortfolioSummary,
  TradingSettings,
  AIInsight,
  NewsItem,
  TradeEvent,
  TradeEventType,
  RiskStatus,
} from '@td/shared';

import type { TradeSignal as SharedTradeSignal } from '@td/shared';

import type { Trade as SharedTrade } from '@td/shared';

export {
  Segment,
  Exchange,
  OrderType,
  OrderSide,
  PositionType,
  OptionType,
  SignalConfidence,
  TradeStatus,
  AutoTradeMode,
} from '@td/shared';

// M5: VIX regime label captured at trade entry.
export type VixRegime = 'LOW' | 'NORMAL' | 'ELEVATED' | 'HIGH' | 'UNKNOWN';

// M5: Structured exit-reason tag captured when a trade is closed.
export type ExitReasonTag =
  | 'HIT_TARGET'
  | 'STOPPED_OUT'
  | 'MOVED_STOP'
  | 'PANIC_EXIT'
  | 'TIME_EXIT'
  | 'REVERSAL_SEEN'
  | 'OTHER';

// M5: Extends the shared Trade type with the new context-capture and
// exit-reason fields. Kept here (rather than mutating @td/shared) so the
// frontend can adopt the new fields independently of the shared package's
// versioning.
export interface Trade extends SharedTrade {
  entryReason?: string | null;
  entryTags?: string[];
  spotAtEntry?: number | null;
  vixAtEntry?: number | null;
  vixRegimeAtEntry?: VixRegime | null;
  pcrAtEntry?: number | null;
  maxPainAtEntry?: number | null;
  adRatioAtEntry?: number | null;
  contextSnapshot?: Record<string, unknown> | null;
  exitReasonTag?: ExitReasonTag | null;
  exitNotes?: string | null;
}

// M5: Tag chip options shown on ExecuteTradeModal — the trader picks zero
// or more of these to characterise *why* they entered the trade. The
// free-text "Why this trade?" textarea handles anything not covered by
// these chips, so a "Custom" option would just duplicate that surface.
export const ENTRY_TAG_OPTIONS = [
  { value: 'OI_BUILDUP', label: 'OI buildup at S/R' },
  { value: 'VWAP_RECLAIM', label: 'VWAP reclaim' },
  { value: 'TREND_CONT', label: 'Trend continuation' },
  { value: 'REVERSAL', label: 'Reversal setup' },
  { value: 'RANGE_BREAK', label: 'Range break' },
  { value: 'EXPIRY_PIN', label: 'Expiry pin play' },
  { value: 'VOL_CRUSH', label: 'Volatility crush' },
  { value: 'NEWS_DRIVEN', label: 'News-driven' },
] as const;

// M5: Exit-reason picker options shown on ExitTradeModal. Values mirror
// the `ExitReasonTag` enum on the backend DTO — keep them in lockstep.
export const EXIT_REASON_OPTIONS: ReadonlyArray<{ value: ExitReasonTag; label: string }> = [
  { value: 'HIT_TARGET', label: 'Hit Target' },
  { value: 'STOPPED_OUT', label: 'Stopped Out' },
  { value: 'MOVED_STOP', label: 'Moved Stop (manual)' },
  { value: 'PANIC_EXIT', label: 'Panic / discretionary exit' },
  { value: 'TIME_EXIT', label: 'Time-based exit (e.g. close near EOD)' },
  { value: 'REVERSAL_SEEN', label: 'Saw reversal — exited early' },
  { value: 'OTHER', label: 'Other' },
] as const;

// Frontend-specific types

export type MarketStatus = 'open' | 'closed' | 'pre-market';

export interface WebSocketEvent<T = unknown> {
  event: string;
  data: T;
  timestamp: number;
}

export interface NavItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

// Levels-context strategy: structured signal payload.
// Mirrors apps/api/src/modules/signal-generator/types/setup-context.types.ts —
// keep them in lockstep.
export type LevelType =
  | 'PDH' | 'PDL' | 'ORH' | 'ORL'
  | 'VWAP' | 'ROUND' | 'VOL_STRIKE';
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
  triggerCandle: { time: number; ohlc: [number, number, number, number] };
  levelBookSnapshot: {
    pdh: number; pdl: number;
    orh: number | null; orl: number | null;
    vwap: number; todayHigh: number; todayLow: number;
  };
  atr14: number;
  volumeRatio: number;
  timeOfDayWindow: TimeOfDayWindow;
  expiryDayWarning?: boolean;
}

export interface TradeSignal extends SharedTradeSignal {
  setupContext?: SetupContext | null;
}
