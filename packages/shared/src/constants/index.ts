// ============================================
// Trading Constants
// ============================================

// Indian market hours (IST)
export const MARKET_OPEN_HOUR = 9;
export const MARKET_OPEN_MINUTE = 15;
export const MARKET_CLOSE_HOUR = 15;
export const MARKET_CLOSE_MINUTE = 30;

// Pre-market session
export const PRE_MARKET_OPEN_HOUR = 9;
export const PRE_MARKET_OPEN_MINUTE = 0;

// MCX market hours
export const MCX_OPEN_HOUR = 9;
export const MCX_OPEN_MINUTE = 0;
export const MCX_CLOSE_HOUR = 23;
export const MCX_CLOSE_MINUTE = 30;

// Major indices tokens (Angel One)
export const INDICES = {
  NIFTY_50: { symbol: 'NIFTY', token: '99926000', exchange: 'NSE' },
  BANK_NIFTY: { symbol: 'BANKNIFTY', token: '99926009', exchange: 'NSE' },
  FIN_NIFTY: { symbol: 'FINNIFTY', token: '99926037', exchange: 'NSE' },
  SENSEX: { symbol: 'SENSEX', token: '99919000', exchange: 'BSE' },
  NIFTY_MIDCAP: { symbol: 'NIFTY MIDCAP 50', token: '99926025', exchange: 'NSE' },
  NIFTY_IT: { symbol: 'NIFTY IT', token: '99926013', exchange: 'NSE' },
} as const;

// Candle timeframes
export const TIMEFRAMES = {
  ONE_MIN: '1m',
  FIVE_MIN: '5m',
  FIFTEEN_MIN: '15m',
  THIRTY_MIN: '30m',
  ONE_HOUR: '1h',
  FOUR_HOUR: '4h',
  DAILY: '1d',
  WEEKLY: '1w',
} as const;

// Risk management defaults
export const DEFAULT_MAX_DAILY_LOSS = 5000; // INR
export const DEFAULT_MAX_CAPITAL_PER_TRADE = 50000; // INR
export const DEFAULT_MAX_CONCURRENT_POSITIONS = 5;
export const DEFAULT_RISK_REWARD_RATIO = 2; // 1:2 minimum
export const DEFAULT_STOPLOSS_PERCENT = 2; // 2% of entry

// Angel One API limits
export const ANGEL_ONE_MAX_REQUESTS_PER_SEC = 10;
export const ANGEL_ONE_WEBSOCKET_MAX_TOKENS = 50;

// Application
export const API_PREFIX = '/api';
export const WS_NAMESPACE = '/ws';
