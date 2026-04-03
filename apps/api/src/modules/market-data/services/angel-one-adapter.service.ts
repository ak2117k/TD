import { Injectable, Logger } from '@nestjs/common';
import {
  BrokerAdapter,
  FeedCallback,
  OrderRequest,
  OrderResponse,
  PositionData,
  TickData,
} from '../../../common/interfaces/broker-adapter.interface';
import { AngelOneAuthService } from './angel-one-auth.service';
import { AngelOneWebSocketService, WsFeedMode, ExchangeType } from './angel-one-websocket.service';
import { COMMODITIES } from '@td/shared/constants';

/**
 * Map our generic order types to Angel One SmartAPI order type strings.
 */
const ORDER_TYPE_MAP: Record<string, string> = {
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
  STOPLOSS: 'STOPLOSS_LIMIT',
  STOPLOSS_MARKET: 'STOPLOSS_MARKET',
};

/**
 * Map our generic position types to Angel One product types.
 */
const PRODUCT_TYPE_MAP: Record<string, string> = {
  INTRADAY: 'INTRADAY',
  DELIVERY: 'DELIVERY',
  CARRYFORWARD: 'CARRYFORWARD',
};

/**
 * Map our timeframe strings to Angel One candle interval strings.
 */
const TIMEFRAME_MAP: Record<string, string> = {
  '1m': 'ONE_MINUTE',
  '3m': 'THREE_MINUTE',
  '5m': 'FIVE_MINUTE',
  '10m': 'TEN_MINUTE',
  '15m': 'FIFTEEN_MINUTE',
  '30m': 'THIRTY_MINUTE',
  '1h': 'ONE_HOUR',
  '1d': 'ONE_DAY',
};

@Injectable()
export class AngelOneAdapterService implements BrokerAdapter {
  private readonly logger = new Logger(AngelOneAdapterService.name);

  constructor(
    public readonly authService: AngelOneAuthService,
    private readonly wsService: AngelOneWebSocketService,
  ) {}

  // ─────────────────────────────────────────────────────
  // Connection lifecycle
  // ─────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.logger.log('Connecting to Angel One SmartAPI');
    if (!this.authService.isAuthenticated()) {
      await this.authService.login();
    }
    await this.wsService.connect();
    this.logger.log('Angel One adapter connected');
  }

  async disconnect(): Promise<void> {
    this.logger.log('Disconnecting from Angel One SmartAPI');
    await this.wsService.disconnect();
    await this.authService.logout();
    this.logger.log('Angel One adapter disconnected');
  }

  // ─────────────────────────────────────────────────────
  // Orders
  // ─────────────────────────────────────────────────────

  async placeOrder(order: OrderRequest): Promise<OrderResponse> {
    try {
      const smartApi = this.authService.getSmartApi();

      const params: Record<string, string> = {
        variety: 'NORMAL',
        tradingsymbol: order.symbol,
        symboltoken: order.token,
        transactiontype: order.side,
        exchange: order.exchange,
        ordertype: ORDER_TYPE_MAP[order.orderType] ?? order.orderType,
        producttype: PRODUCT_TYPE_MAP[order.positionType] ?? order.positionType,
        duration: 'DAY',
        quantity: String(order.quantity),
      };

      if (order.price != null && order.price > 0) {
        params.price = String(order.price);
      } else {
        params.price = '0';
      }

      if (order.triggerPrice != null && order.triggerPrice > 0) {
        params.triggerprice = String(order.triggerPrice);
      } else {
        params.triggerprice = '0';
      }

      this.logger.log(
        `Placing ${order.orderType} ${order.side} order for ${order.symbol} qty=${order.quantity}`,
      );

      const response = await smartApi.placeOrder(params);

      if (!response?.data?.orderid) {
        return {
          orderId: '',
          status: 'REJECTED',
          message: response?.message ?? 'Order placement failed',
        };
      }

      return {
        orderId: response.data.orderid,
        status: 'PLACED',
        message: response.message ?? 'Order placed successfully',
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to place order: ${msg}`);
      return {
        orderId: '',
        status: 'FAILED',
        message: msg,
      };
    }
  }

  async modifyOrder(
    orderId: string,
    updates: Partial<OrderRequest>,
  ): Promise<OrderResponse> {
    try {
      const smartApi = this.authService.getSmartApi();

      const params: Record<string, string> = {
        variety: 'NORMAL',
        orderid: orderId,
      };

      if (updates.orderType) {
        params.ordertype = ORDER_TYPE_MAP[updates.orderType] ?? updates.orderType;
      }
      if (updates.quantity != null) {
        params.quantity = String(updates.quantity);
      }
      if (updates.price != null) {
        params.price = String(updates.price);
      }
      if (updates.triggerPrice != null) {
        params.triggerprice = String(updates.triggerPrice);
      }

      this.logger.log(`Modifying order ${orderId}`);
      const response = await smartApi.modifyOrder(params);

      if (!response?.data?.orderid) {
        return {
          orderId,
          status: 'REJECTED',
          message: response?.message ?? 'Order modification failed',
        };
      }

      return {
        orderId: response.data.orderid,
        status: 'MODIFIED',
        message: response.message ?? 'Order modified successfully',
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to modify order ${orderId}: ${msg}`);
      return {
        orderId,
        status: 'FAILED',
        message: msg,
      };
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    try {
      const smartApi = this.authService.getSmartApi();

      this.logger.log(`Cancelling order ${orderId}`);
      const response = await smartApi.cancelOrder({
        variety: 'NORMAL',
        orderid: orderId,
      });

      if (!response?.status) {
        throw new Error(response?.message ?? 'Order cancellation failed');
      }

      this.logger.log(`Order ${orderId} cancelled successfully`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to cancel order ${orderId}: ${msg}`);
      throw new Error(`Cancel order failed: ${msg}`);
    }
  }

  // ─────────────────────────────────────────────────────
  // Positions & Orders
  // ─────────────────────────────────────────────────────

  async getPositions(): Promise<PositionData[]> {
    try {
      const smartApi = this.authService.getSmartApi();
      const response = await smartApi.getPosition();

      if (!response?.data) {
        return [];
      }

      const positions: any[] = Array.isArray(response.data)
        ? response.data
        : response.data.net ?? response.data.day ?? [];

      return positions.map((p: any) => ({
        symbol: p.tradingsymbol ?? p.symbolname ?? '',
        exchange: p.exchange ?? '',
        side: Number(p.netqty ?? p.buyqty ?? 0) >= 0 ? 'BUY' : 'SELL',
        quantity: Math.abs(Number(p.netqty ?? 0)),
        averagePrice: Number(p.averageprice ?? p.netprice ?? 0),
        ltp: Number(p.ltp ?? 0),
        pnl: Number(p.pnl ?? p.unrealised ?? p.realised ?? 0),
      }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to fetch positions: ${msg}`);
      throw new Error(`Get positions failed: ${msg}`);
    }
  }

  async getOrders(): Promise<any[]> {
    try {
      const smartApi = this.authService.getSmartApi();
      const response = await smartApi.getOrderBook();

      if (!response?.data) {
        return [];
      }

      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to fetch order book: ${msg}`);
      throw new Error(`Get orders failed: ${msg}`);
    }
  }

  // ─────────────────────────────────────────────────────
  // Market data — REST
  // ─────────────────────────────────────────────────────

  async getLiveQuote(token: string, exchange: string): Promise<TickData> {
    try {
      const smartApi = this.authService.getSmartApi();

      const response = await smartApi.marketData({
        mode: 'FULL',
        exchangeTokens: { [exchange]: [token] },
      });

      // Debug: log raw response structure for first few calls
      if (!response?.data?.fetched?.length) {
        this.logger.debug(
          `marketData raw for ${token}/${exchange}: ${JSON.stringify({
            status: response?.status,
            message: response?.message,
            hasData: !!response?.data,
            dataKeys: response?.data ? Object.keys(response.data) : [],
            fetched: response?.data?.fetched?.length ?? 0,
            unfetched: response?.data?.unfetched?.length ?? 0,
          })}`,
        );
        throw new Error(response?.message ?? 'Market data fetch failed');
      }

      const d = response.data.fetched[0];
      return {
        token: String(d.symbolToken ?? d.symboltoken ?? token),
        symbol: d.tradingSymbol ?? d.tradingsymbol ?? '',
        ltp: Number(d.ltp ?? 0),
        open: Number(d.open ?? 0),
        high: Number(d.high ?? 0),
        low: Number(d.low ?? 0),
        close: Number(d.close ?? 0),
        volume: Number(d.tradeVolume ?? d.volume ?? 0),
        oi: d.opnInterest != null ? Number(d.opnInterest) : undefined,
        timestamp: new Date(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to get live quote for ${token}: ${msg}`);
      throw new Error(`Get live quote failed: ${msg}`);
    }
  }

  async getHistoricalData(
    token: string,
    exchange: string,
    timeframe: string,
    from: Date,
    to: Date,
  ): Promise<any[]> {
    try {
      const smartApi = this.authService.getSmartApi();

      const interval = TIMEFRAME_MAP[timeframe] ?? timeframe;
      const fromStr = this.formatDateTime(from);
      const toStr = this.formatDateTime(to);

      this.logger.log(
        `Fetching historical data: token=${token} exchange=${exchange} interval=${interval} ${fromStr} to ${toStr}`,
      );

      const response = await smartApi.getCandleData({
        exchange,
        symboltoken: token,
        interval,
        fromdate: fromStr,
        todate: toStr,
      });

      if (!response?.data) {
        return [];
      }

      // SmartAPI returns candles as arrays: [timestamp, open, high, low, close, volume]
      return (response.data as any[]).map((candle: any[]) => ({
        timestamp: new Date(candle[0]),
        open: Number(candle[1]),
        high: Number(candle[2]),
        low: Number(candle[3]),
        close: Number(candle[4]),
        volume: Number(candle[5]),
      }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to fetch historical data: ${msg}`);
      throw new Error(`Get historical data failed: ${msg}`);
    }
  }

  async searchInstruments(query: string, exchange = 'NFO'): Promise<any[]> {
    try {
      const smartApi = this.authService.getSmartApi();

      // SmartAPI searchScrip returns data.data directly (already extracted by SDK)
      const result = await smartApi.searchScrip({
        exchange,
        searchscrip: query,
      });

      // The SDK may return the array directly, or wrapped in { data: [...] }
      if (Array.isArray(result)) return result;
      if (result?.data && Array.isArray(result.data)) return result.data;
      return [];
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Instrument search failed for "${query}" on ${exchange}: ${msg}`);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────
  // Market data — WebSocket
  // ─────────────────────────────────────────────────────

  subscribeToFeed(tokens: string[], callback: FeedCallback): void {
    // Register the callback for tick events
    this.wsService.on('tick', callback);

    // Separate tokens by exchange — MCX tokens need MCX_FO exchange type
    const mcxTokens = new Set<string>();
    for (const c of Object.values(COMMODITIES)) {
      if (c.token && c.token !== '0') mcxTokens.add(c.token);
    }

    const nseTokenList = tokens.filter((t) => !mcxTokens.has(t));
    const mcxTokenList = tokens.filter((t) => mcxTokens.has(t));

    // Subscribe NSE tokens
    if (nseTokenList.length > 0) {
      this.wsService
        .subscribe(nseTokenList, WsFeedMode.SNAP_QUOTE, ExchangeType.NSE_CM)
        .catch((error) => {
          this.logger.error(
            `NSE feed subscription failed: ${error instanceof Error ? error.message : error}`,
          );
        });
    }

    // Subscribe MCX tokens
    if (mcxTokenList.length > 0) {
      this.wsService
        .subscribe(mcxTokenList, WsFeedMode.SNAP_QUOTE, ExchangeType.MCX_FO)
        .catch((error) => {
          this.logger.error(
            `MCX feed subscription failed: ${error instanceof Error ? error.message : error}`,
          );
        });
    }
  }

  unsubscribeFromFeed(tokens: string[]): void {
    this.wsService.unsubscribe(tokens).catch((error) => {
      this.logger.error(
        `Feed unsubscription failed: ${error instanceof Error ? error.message : error}`,
      );
    });
  }

  // ─────────────────────────────────────────────────────
  // Instrument master (OpenAPI ScripMaster)
  // ─────────────────────────────────────────────────────

  /**
   * Download the full Angel One instrument master list from the public CDN.
   * Returns raw records for the requested exchange/segment.
   *
   * The file at this URL is a JSON array of objects like:
   * { token, symbol, name, expiry, strike, lotsize, instrumenttype,
   *   exch_seg, tick_size, ... }
   *
   * instrumenttype for options: "OPTIDX" (index options) or "OPTSTK" (stock options)
   * exch_seg: "NFO" for F&O segment
   */
  async fetchInstrumentMaster(
    exchange: string = 'NFO',
  ): Promise<any[]> {
    const url =
      'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

    this.logger.log(`Downloading instrument master from Angel One CDN`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to download instrument master: HTTP ${response.status}`,
      );
    }

    const allInstruments: any[] = await response.json();
    this.logger.log(
      `Downloaded ${allInstruments.length} total instruments from Angel One`,
    );

    // Filter to requested exchange segment
    const filtered = allInstruments.filter(
      (i: any) => i.exch_seg === exchange,
    );
    this.logger.log(
      `Filtered to ${filtered.length} instruments for ${exchange}`,
    );

    return filtered;
  }

  /**
   * Get option contracts for a specific underlying from the Angel One master list.
   * Filters by underlying name and returns option-specific fields.
   */
  async getOptionContracts(
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
  > {
    const master = instrumentMaster ?? (await this.fetchInstrumentMaster('NFO'));

    // Angel One uses "OPTIDX" for index options and "OPTSTK" for stock options
    const instrumentTypes =
      ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'].includes(
        underlying.toUpperCase(),
      )
        ? ['OPTIDX']
        : ['OPTSTK'];

    const upperUnderlying = underlying.toUpperCase();

    const options = master
      .filter((i: any) => {
        if (!instrumentTypes.includes(i.instrumenttype)) return false;
        // The "name" field in the master contains the underlying name
        // e.g., "NIFTY", "BANKNIFTY"
        if ((i.name ?? '').toUpperCase() !== upperUnderlying) return false;
        // Must have strike and expiry
        if (!i.strike || !i.expiry) return false;
        return true;
      })
      .map((i: any) => {
        // Parse expiry: format is "DDMMMYYYY" e.g., "27MAR2026"
        // or sometimes "27Mar2026"
        const expiryStr = String(i.expiry).trim();
        let expiry: Date;
        try {
          expiry = new Date(expiryStr);
          if (isNaN(expiry.getTime())) {
            // Try manual parsing: DDMMMYYYY
            const months: Record<string, number> = {
              JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
              JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
            };
            const day = parseInt(expiryStr.substring(0, 2));
            const mon = months[expiryStr.substring(2, 5).toUpperCase()];
            const year = parseInt(expiryStr.substring(5));
            expiry = new Date(year, mon, day);
          }
        } catch {
          expiry = new Date(expiryStr);
        }

        // Strike in the master is a string like "22500.000000" or "22500"
        const strike = parseFloat(String(i.strike));

        // Determine option type from the symbol suffix
        // Symbols end with CE or PE, e.g., "NIFTY27MAR2622500CE"
        const sym = String(i.symbol).toUpperCase();
        const optionType = sym.endsWith('PE') ? 'PE' : 'CE';

        return {
          token: String(i.token),
          symbol: String(i.symbol),
          name: String(i.name ?? underlying),
          exchange: 'NFO',
          expiry,
          strike,
          optionType: optionType as 'CE' | 'PE',
          lotSize: parseInt(String(i.lotsize ?? '1')) || 1,
        };
      })
      .filter(
        (o: { expiry: Date }) => !isNaN(o.expiry.getTime()) && o.expiry >= new Date(),
      );

    this.logger.log(
      `Found ${options.length} active option contracts for ${underlying}`,
    );

    return options;
  }

  // ─────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────

  /**
   * Format a Date to the string format expected by Angel One: "YYYY-MM-DD HH:mm"
   */
  private formatDateTime(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d} ${hh}:${mm}`;
  }
}
