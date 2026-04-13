/**
 * Trading Strategy Interface
 *
 * All trading algorithms implement this interface.
 * To add a new strategy, create a new class that implements
 * TradingStrategy and register it in the signal-generator module.
 */

export interface MarketSnapshot {
  symbol: string;
  exchange: string;
  ltp: number;
  candles: CandleData[];
  oi?: number;
  oiChange?: number;
  volume: number;
  /**
   * Optional multi-timeframe candle data for strategies that need to
   * evaluate conditions across several intervals at once (e.g. a 15m
   * strategy that also checks 1m / 5m / 1h alignment). Existing
   * single-timeframe strategies ignore this field; MTF-aware ones
   * read from `mtfCandles['1m']`, `mtfCandles['5m']`, etc.
   */
  mtfCandles?: Record<string, CandleData[]>;
}

export interface CandleData {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SignalOutput {
  symbol: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  targetPrice: number;
  stoplossPrice: number;
  confidence: number; // 0-100
  reason: string;
  timeframe: string;
  metadata?: Record<string, any>;
}

export interface BacktestInput {
  candles: CandleData[];
  initialCapital: number;
  positionSize: number;
}

export interface BacktestResult {
  totalTrades: number;
  winRate: number;
  totalReturn: number;
  totalReturnPercent: number;
  maxDrawdown: number;
  sharpeRatio: number;
  trades: BacktestTrade[];
}

export interface BacktestTrade {
  entryTime: Date;
  exitTime: Date;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  reason: string;
}

export interface TradingStrategy {
  /** Unique name of the strategy */
  readonly name: string;

  /** Human-readable description */
  readonly description: string;

  /** Which segments this strategy supports */
  readonly supportedSegments: string[];

  /** Which timeframes this strategy works best with */
  readonly preferredTimeframes: string[];

  /** Analyze current market data and return a signal or null */
  analyze(data: MarketSnapshot): SignalOutput | null;

  /** Run backtest against historical data */
  backtest(input: BacktestInput): BacktestResult;

  /** Get current strategy parameters */
  getParameters(): Record<string, any>;

  /** Update strategy parameters */
  setParameters(params: Record<string, any>): void;
}
