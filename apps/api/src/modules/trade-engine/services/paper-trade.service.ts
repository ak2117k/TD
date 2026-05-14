import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  OrderRequest,
  OrderResponse,
  TickData,
} from '../../../common/interfaces/broker-adapter.interface';
import { TradeRepository } from '../repositories/trade.repository';
import { v4 as uuidv4 } from 'uuid';

/** Simulated slippage range: 0.01% to 0.05%. */
const MIN_SLIPPAGE_PCT = 0.0001;
const MAX_SLIPPAGE_PCT = 0.0005;

/** Default starting virtual capital (INR). ₹20,00,000 (20 lakhs). */
const DEFAULT_VIRTUAL_CAPITAL = 2_000_000;

interface PendingPaperOrder {
  id: string;
  request: OrderRequest;
  createdAt: Date;
}

interface VirtualPosition {
  symbol: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  averagePrice: number;
  ltp: number;
  pnl: number;
}

@Injectable()
export class PaperTradeService implements OnModuleInit {
  private readonly logger = new Logger(PaperTradeService.name);

  /** Pending limit/SL orders waiting for price triggers. */
  private readonly pendingOrders = new Map<string, PendingPaperOrder>();

  /** Virtual positions keyed by `symbol:exchange:side`. */
  private readonly virtualPositions = new Map<string, VirtualPosition>();

  /** Virtual cash balance. */
  private virtualBalance = DEFAULT_VIRTUAL_CAPITAL;

  /** Callbacks for when a pending order fills. */
  private readonly fillCallbacks = new Map<
    string,
    (response: OrderResponse) => void
  >();

  /** LTP cache for simulating fills. */
  private readonly ltpCache = new Map<string, number>();

  constructor(private readonly tradeRepository: TradeRepository) {}

  /**
   * On API startup, replay every persisted paper trade to recover the balance.
   * The trades table is the source of truth — we never store balance separately,
   * so in-memory state cannot drift from the trade history.
   *
   * Replay rules (mirror what fillAtPrice does on each fill):
   *   - Closed BUY  : balance += pnl                                (= -entry×qty + exit×qty)
   *   - Closed SELL : balance += pnl                                (= +entry×qty - exit×qty)
   *   - Open   BUY  : balance -= entry × qty                        (only the opening fill ran)
   *   - Open   SELL : balance += entry × qty                        (short credits cash on open)
   */
  async onModuleInit(): Promise<void> {
    try {
      const paperTrades = await this.tradeRepository.findAllPaperTrades();
      let bal = DEFAULT_VIRTUAL_CAPITAL;
      let realized = 0;
      let openCount = 0;
      let deployed = 0;
      for (const t of paperTrades) {
        const isClosed = t.status === 'CLOSED' && t.exitPrice != null && t.pnl != null;
        if (isClosed) {
          bal += t.pnl ?? 0;
          realized += t.pnl ?? 0;
        } else if (t.entryPrice != null && (t.status === 'OPEN' || t.status === 'PENDING')) {
          const orderValue = t.entryPrice * t.quantity;
          if (t.side === 'BUY') {
            bal -= orderValue;
            deployed += orderValue;
          } else {
            bal += orderValue;
            deployed += orderValue;
          }
          openCount++;
        }
      }
      this.virtualBalance = bal;
      this.logger.log(
        `[Paper] Balance recovered from ${paperTrades.length} trades: ` +
          `start=₹${DEFAULT_VIRTUAL_CAPITAL.toLocaleString('en-IN')} → ` +
          `current=₹${bal.toLocaleString('en-IN')} ` +
          `(realized=₹${realized.toFixed(0)}, open=${openCount}, deployed=₹${deployed.toFixed(0)})`,
      );
    } catch (err) {
      this.logger.warn(
        `[Paper] Balance recovery failed — keeping default ₹${DEFAULT_VIRTUAL_CAPITAL.toLocaleString('en-IN')}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  /**
   * Simulate order execution.
   * MARKET orders fill immediately at LTP with slippage.
   * LIMIT / STOPLOSS orders are stored as pending and checked on every tick.
   */
  async simulateOrder(request: OrderRequest): Promise<OrderResponse> {
    const orderId = `PAPER-${uuidv4().slice(0, 8).toUpperCase()}`;

    this.logger.log(
      `[Paper] Simulating ${request.orderType} ${request.side} order: ${request.symbol} x${request.quantity}`,
    );

    if (request.orderType === 'MARKET') {
      return this.fillMarketOrder(orderId, request);
    }

    // LIMIT / STOPLOSS / STOPLOSS_MARKET: store as pending
    this.pendingOrders.set(orderId, {
      id: orderId,
      request,
      createdAt: new Date(),
    });

    // Check if we can fill immediately based on cached LTP
    const ltp = this.ltpCache.get(`${request.token}:${request.exchange}`);
    if (ltp !== undefined) {
      const canFill = this.canFillAtPrice(request, ltp);
      if (canFill) {
        this.pendingOrders.delete(orderId);
        return this.fillAtPrice(orderId, request, ltp);
      }
    }

    return {
      orderId,
      status: 'PENDING',
      message: `Paper order pending — waiting for price trigger`,
    };
  }

  /**
   * Called on every tick to check if any pending paper orders should fill.
   */
  simulateTick(tick: TickData): void {
    this.ltpCache.set(`${tick.token}:${tick.symbol}`, tick.ltp);

    // Update virtual positions with latest LTP
    for (const pos of this.virtualPositions.values()) {
      if (pos.symbol === tick.symbol) {
        pos.ltp = tick.ltp;
        const multiplier = pos.side === 'BUY' ? 1 : -1;
        pos.pnl = multiplier * (tick.ltp - pos.averagePrice) * pos.quantity;
      }
    }

    // Check pending orders
    for (const [orderId, pending] of this.pendingOrders.entries()) {
      if (pending.request.token !== tick.token) continue;

      if (this.canFillAtPrice(pending.request, tick.ltp)) {
        this.pendingOrders.delete(orderId);
        const response = this.fillAtPrice(orderId, pending.request, tick.ltp);

        const callback = this.fillCallbacks.get(orderId);
        if (callback) {
          callback(response);
          this.fillCallbacks.delete(orderId);
        }

        this.logger.log(
          `[Paper] Pending order ${orderId} filled at ${tick.ltp}`,
        );
      }
    }
  }

  /**
   * Register a callback for when a pending paper order fills.
   */
  onOrderFill(orderId: string, callback: (response: OrderResponse) => void): void {
    this.fillCallbacks.set(orderId, callback);
  }

  getVirtualBalance(): number {
    return this.virtualBalance;
  }

  getVirtualPositions(): VirtualPosition[] {
    return Array.from(this.virtualPositions.values());
  }

  /**
   * Account summary for the UI badge: starting capital, current cash balance,
   * deployed capital tied up in open positions, and unrealized P&L from live
   * ticks. `equity = balance + deployed + unrealizedPnl` is the total mark-to-
   * market account value.
   */
  getAccount(): {
    startingCapital: number;
    balance: number;
    deployedCapital: number;
    unrealizedPnl: number;
    equity: number;
    openPositions: number;
  } {
    const positions = Array.from(this.virtualPositions.values());
    let deployed = 0;
    let unrealized = 0;
    for (const p of positions) {
      deployed += p.averagePrice * p.quantity;
      unrealized += p.pnl;
    }
    return {
      startingCapital: DEFAULT_VIRTUAL_CAPITAL,
      balance: this.virtualBalance,
      deployedCapital: deployed,
      unrealizedPnl: unrealized,
      equity: this.virtualBalance + deployed + unrealized,
      openPositions: positions.length,
    };
  }

  getPendingOrders(): PendingPaperOrder[] {
    return Array.from(this.pendingOrders.values());
  }

  resetVirtualPortfolio(startingCapital?: number): void {
    this.virtualBalance = startingCapital ?? DEFAULT_VIRTUAL_CAPITAL;
    this.virtualPositions.clear();
    this.pendingOrders.clear();
    this.fillCallbacks.clear();
    this.logger.log(
      `[Paper] Virtual portfolio reset. Balance: ${this.virtualBalance}`,
    );
  }

  // ------------------------------------------------------------------
  //  Private helpers
  // ------------------------------------------------------------------

  private fillMarketOrder(
    orderId: string,
    request: OrderRequest,
  ): OrderResponse {
    const ltp =
      this.ltpCache.get(`${request.token}:${request.exchange}`) ??
      request.price ??
      0;

    return this.fillAtPrice(orderId, request, ltp);
  }

  private fillAtPrice(
    orderId: string,
    request: OrderRequest,
    basePrice: number,
  ): OrderResponse {
    const slippage = this.calculateSlippage(basePrice, request.side);
    const fillPrice = basePrice + slippage;

    // Update virtual balance
    const orderValue = fillPrice * request.quantity;
    if (request.side === 'BUY') {
      this.virtualBalance -= orderValue;
    } else {
      this.virtualBalance += orderValue;
    }

    // Update virtual positions
    const posKey = `${request.symbol}:${request.exchange}:${request.side}`;
    const existing = this.virtualPositions.get(posKey);

    if (existing) {
      // Average into existing position
      const totalQty = existing.quantity + request.quantity;
      existing.averagePrice =
        (existing.averagePrice * existing.quantity +
          fillPrice * request.quantity) /
        totalQty;
      existing.quantity = totalQty;
    } else {
      this.virtualPositions.set(posKey, {
        symbol: request.symbol,
        exchange: request.exchange,
        side: request.side as 'BUY' | 'SELL',
        quantity: request.quantity,
        averagePrice: fillPrice,
        ltp: fillPrice,
        pnl: 0,
      });
    }

    this.logger.log(
      `[Paper] Order ${orderId} filled: ${request.side} ${request.symbol} x${request.quantity} @ ${fillPrice.toFixed(2)}`,
    );

    return {
      orderId,
      status: 'FILLED',
      message: `Paper trade filled at ${fillPrice.toFixed(2)} (slippage: ${slippage.toFixed(4)})`,
      fillPrice,
    };
  }

  private canFillAtPrice(request: OrderRequest, ltp: number): boolean {
    switch (request.orderType) {
      case 'LIMIT':
        // BUY limit fills when price drops to or below limit
        // SELL limit fills when price rises to or above limit
        if (request.side === 'BUY' && request.price !== undefined) {
          return ltp <= request.price;
        }
        if (request.side === 'SELL' && request.price !== undefined) {
          return ltp >= request.price;
        }
        return false;

      case 'STOPLOSS':
      case 'STOPLOSS_MARKET':
        // BUY SL triggers when price rises above trigger
        // SELL SL triggers when price falls below trigger
        if (
          request.side === 'BUY' &&
          request.triggerPrice !== undefined
        ) {
          return ltp >= request.triggerPrice;
        }
        if (
          request.side === 'SELL' &&
          request.triggerPrice !== undefined
        ) {
          return ltp <= request.triggerPrice;
        }
        return false;

      default:
        return false;
    }
  }

  /**
   * Simulate realistic slippage between 0.01% and 0.05%.
   * BUY orders slip up, SELL orders slip down (adverse fill).
   */
  private calculateSlippage(price: number, side: string): number {
    const pct =
      MIN_SLIPPAGE_PCT +
      Math.random() * (MAX_SLIPPAGE_PCT - MIN_SLIPPAGE_PCT);
    const slippage = price * pct;
    return side === 'BUY' ? slippage : -slippage;
  }
}
