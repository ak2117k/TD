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
import { AngelOneWebSocketService, WsFeedMode } from './angel-one-websocket.service';

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
    private readonly authService: AngelOneAuthService,
    private readonly wsService: AngelOneWebSocketService,
  ) {}

  // ─────────────────────────────────────────────────────
  // Connection lifecycle
  // ─────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.logger.log('Connecting to Angel One SmartAPI');
    await this.authService.login();
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

  async getLiveQuote(symbol: string, exchange: string): Promise<TickData> {
    try {
      const smartApi = this.authService.getSmartApi();

      const response = await smartApi.ltpData(exchange, symbol, symbol);

      if (!response?.data) {
        throw new Error(response?.message ?? 'LTP fetch failed');
      }

      const d = response.data;
      return {
        token: String(d.symboltoken ?? d.symbolToken ?? ''),
        symbol: d.tradingsymbol ?? d.tradingSymbol ?? symbol,
        ltp: Number(d.ltp ?? 0),
        open: Number(d.open ?? 0),
        high: Number(d.high ?? 0),
        low: Number(d.low ?? 0),
        close: Number(d.close ?? 0),
        volume: Number(d.volume ?? 0),
        timestamp: new Date(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to get live quote for ${symbol}: ${msg}`);
      throw new Error(`Get live quote failed: ${msg}`);
    }
  }

  async getHistoricalData(
    symbol: string,
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
        `Fetching historical data: ${symbol} ${exchange} ${interval} ${fromStr} to ${toStr}`,
      );

      const response = await smartApi.getCandleData({
        exchange,
        symboltoken: symbol,
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

  async searchInstruments(query: string): Promise<any[]> {
    try {
      const smartApi = this.authService.getSmartApi();

      const response = await smartApi.searchScrip(query);

      if (!response?.data) {
        return [];
      }

      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Instrument search failed for "${query}": ${msg}`);
      throw new Error(`Search instruments failed: ${msg}`);
    }
  }

  // ─────────────────────────────────────────────────────
  // Market data — WebSocket
  // ─────────────────────────────────────────────────────

  subscribeToFeed(tokens: string[], callback: FeedCallback): void {
    // Register the callback for tick events
    this.wsService.on('tick', callback);

    // Subscribe via WebSocket
    this.wsService
      .subscribe(tokens, WsFeedMode.SNAP_QUOTE)
      .catch((error) => {
        this.logger.error(
          `Feed subscription failed: ${error instanceof Error ? error.message : error}`,
        );
      });
  }

  unsubscribeFromFeed(tokens: string[]): void {
    this.wsService.unsubscribe(tokens).catch((error) => {
      this.logger.error(
        `Feed unsubscription failed: ${error instanceof Error ? error.message : error}`,
      );
    });
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
