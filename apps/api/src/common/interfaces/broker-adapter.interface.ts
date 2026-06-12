/**
 * Broker Adapter Interface
 *
 * All broker integrations implement this interface.
 * To add a new broker (e.g., Zerodha, Upstox), create a new class
 * that implements BrokerAdapter. No existing code changes needed.
 */

export interface FeedCallback {
  (data: TickData): void;
}

export interface TickData {
  token: string;
  symbol: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
  timestamp: Date;
}

export interface OrderRequest {
  symbol: string;
  token: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT' | 'STOPLOSS' | 'STOPLOSS_MARKET';
  quantity: number;
  price?: number;
  triggerPrice?: number;
  positionType: 'INTRADAY' | 'DELIVERY' | 'CARRYFORWARD';
  /** Origin track of the order: MANUAL | WATCH | AUTO | SCANNER. Carried
   *  through execution so the persisted Trade row records where it came from.
   *  Defaults to MANUAL at the execution boundary when omitted. */
  source?: 'MANUAL' | 'WATCH' | 'AUTO' | 'SCANNER';
}

export interface OrderResponse {
  orderId: string;
  status: string;
  message: string;
  /**
   * Filled price (with slippage applied) for paper-trade MARKET orders;
   * undefined for limit-pending or live orders.
   */
  fillPrice?: number;
}

export interface PositionData {
  symbol: string;
  exchange: string;
  side: string;
  quantity: number;
  averagePrice: number;
  ltp: number;
  pnl: number;
}

export interface BrokerAdapter {
  /** Initialize connection and authenticate */
  connect(): Promise<void>;

  /** Disconnect and cleanup */
  disconnect(): Promise<void>;

  /** Place an order */
  placeOrder(order: OrderRequest): Promise<OrderResponse>;

  /** Modify an existing order */
  modifyOrder(orderId: string, updates: Partial<OrderRequest>): Promise<OrderResponse>;

  /** Cancel an order */
  cancelOrder(orderId: string): Promise<void>;

  /** Get all open positions */
  getPositions(): Promise<PositionData[]>;

  /** Get order book */
  getOrders(): Promise<any[]>;

  /** Get live quote for a symbol */
  getLiveQuote(symbol: string, exchange: string): Promise<TickData>;

  /** Subscribe to live feed for multiple tokens */
  subscribeToFeed(tokens: string[], callback: FeedCallback): void;

  /** Unsubscribe from live feed */
  unsubscribeFromFeed(tokens: string[]): void;

  /**
   * Subscribe a single token to the live feed with an explicit exchange.
   * Used by the ad-hoc "viewing" subscription path so an arbitrary
   * stock the user opens on the chart gets routed to the right WS
   * exchange (NSE_CM, BSE_CM, MCX_FO etc.) without depending on the
   * hardcoded membership tests in subscribeToFeed.
   */
  subscribeAdHoc?(token: string, exchange: string): Promise<void> | void;

  /** Get historical candle data */
  getHistoricalData(
    symbol: string,
    exchange: string,
    timeframe: string,
    from: Date,
    to: Date,
  ): Promise<any[]>;

  /** Search instruments */
  searchInstruments(query: string, exchange?: string): Promise<any[]>;

  /** Download the full instrument master list for a given exchange */
  fetchInstrumentMaster?(exchange?: string): Promise<any[]>;

  /** Get option contracts for an underlying from the instrument master */
  getOptionContracts?(
    underlying: string,
    instrumentMaster?: any[],
  ): Promise<
    Array<{
      token: string;
      symbol: string;
      name: string;
      exchange: string;
      expiry: Date;
      strike: number;
      optionType: 'CE' | 'PE';
      lotSize: number;
    }>
  >;
}
