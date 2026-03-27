// Re-export all shared types
export type {
  Quote,
  Candle,
  OIData,
  OptionsChainEntry,
  OptionData,
  TradeSignal,
  OrderRequest,
  Position,
  PortfolioSummary,
  TradingSettings,
  AIInsight,
  NewsItem,
} from '@td/shared';

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
