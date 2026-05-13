export type WatchStatus =
  | 'WATCHING' | 'TRADED' | 'TARGET_HIT' | 'STOPPED' | 'EXITED' | 'DISMISSED';

export type WatchEventType =
  | 'INITIAL' | 'PRICE_CHANGE' | 'SCORE_CHANGE' | 'TARGET_HIT'
  | 'SL_HIT_SCORE' | 'SL_HIT_PRICE' | 'TRADE_OPENED' | 'TRADE_CLOSED' | 'DISMISSED';

export interface WatchEntry {
  id: string;
  alertId: string | null;
  setupId: string | null;
  symbol: string;
  token: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  initialPrice: number;
  initialScore: number;
  initialBreakdown: unknown;
  initialAt: string;
  profitTarget: number;
  profitTargetSource: 'indicator-sr' | 'fallback-10pct';
  stopLossScore: number;
  status: WatchStatus;
  currentPrice: number | null;
  currentScore: number | null;
  maxFavorable: number | null;
  maxAdverse: number | null;
  lastTickAt: string | null;
  lastRescoreAt: string | null;
  optionsToken: string | null;
  optionsType: 'CE' | 'PE' | null;
  optionsExpiry: string | null;
  optionsStrike: number | null;
  optionsLotSize: number | null;
  optionsSelectionScore: number | null;
  paperTradeId: string | null;
  liveTradeId: string | null;
  executedAt: string | null;
  executedPrice: number | null;
  closedAt: string | null;
  closedReason: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WatchEvent {
  id: string;
  watchEntryId: string;
  eventType: WatchEventType;
  price: number | null;
  score: number | null;
  breakdown: unknown;
  priceDelta: number | null;
  scoreDelta: number | null;
  notes: string | null;
  createdAt: string;
}

export interface WatchEntryWithEvents extends WatchEntry {
  events: WatchEvent[];
}
