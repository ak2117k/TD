import {
  Injectable,
  Logger,
  Inject,
  Optional,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import {
  BrokerAdapter,
  OrderRequest,
  TickData,
} from '../../../common/interfaces/broker-adapter.interface';
import { BROKER_ADAPTER_TOKEN } from '../../market-data/services/market-feed.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { MarketContextService } from '../../market-data/services/market-context.service';
import { SettingsService } from '../../settings/services/settings.service';
import { PaperTradeService } from './paper-trade.service';
import { RiskManagerService } from './risk-manager.service';
import { OrderTrackerService } from './order-tracker.service';
import { PositionManagerService } from './position-manager.service';
import { TradeRepository } from '../repositories/trade.repository';
import { TradeGateway } from '../gateways/trade.gateway';
import {
  ExecuteTradeDto,
  ModifyTradeDto,
  TradeFilterDto,
  ExitReasonTag,
} from '../dto/trade.dto';
import { Trade, Prisma } from '@prisma/client';

/**
 * Strip an option/futures suffix to recover the underlying symbol.
 * "NIFTY24APR22500CE" → "NIFTY", "BANKNIFTY24APR45000PE" → "BANKNIFTY".
 * Used so MarketContextService can fetch the index-level context (spot,
 * PCR, max-pain) even when the trade is on a derivative leg.
 */
function deriveUnderlying(symbol: string): string {
  const upper = (symbol ?? '').toUpperCase();
  const match = upper.match(/^(MIDCPNIFTY|BANKNIFTY|FINNIFTY|NIFTY|SENSEX)/);
  if (match) return match[1];
  return upper;
}

@Injectable()
export class TradeExecutionService {
  private readonly logger = new Logger(TradeExecutionService.name);

  constructor(
    @Optional()
    @Inject(BROKER_ADAPTER_TOKEN)
    private readonly brokerAdapter: BrokerAdapter | null,
    private readonly paperTradeService: PaperTradeService,
    private readonly riskManagerService: RiskManagerService,
    private readonly orderTrackerService: OrderTrackerService,
    private readonly positionManagerService: PositionManagerService,
    private readonly tradeRepository: TradeRepository,
    private readonly tradeGateway: TradeGateway,
    private readonly settingsService: SettingsService,
    private readonly marketFeedService: MarketFeedService,
    private readonly marketContextService: MarketContextService,
  ) {}

  /**
   * Execute a trade. This is the SINGLE entry point for ALL trade execution.
   *
   * Flow:
   * 1. Risk validation (ALWAYS, even for paper trades)
   * 2. Route to paper or real broker
   * 3. Persist trade record
   * 4. Track order lifecycle
   * 5. Emit WebSocket update
   */
  async executeTrade(request: ExecuteTradeDto): Promise<Trade> {
    this.logger.log(
      `Executing trade: ${request.side} ${request.symbol} x${request.quantity} (${request.orderType})`,
    );

    // ---- STEP 1: Risk validation — MANDATORY, NEVER SKIP ----
    const riskResult = await this.riskManagerService.validateTrade(request);
    if (!riskResult.allowed) {
      this.logger.warn(
        `Trade blocked by risk manager: ${riskResult.reason}`,
      );
      throw new HttpException(
        `Trade rejected: ${riskResult.reason}`,
        HttpStatus.FORBIDDEN,
      );
    }

    // ---- STEP 2: Determine paper vs. real trading mode ----
    const settings = await this.settingsService.getSettings();
    const isPaperTrade = settings.paperTrading;

    // ---- STEP 3: Resolve instrument ID for the trade record ----
    const instrumentId = await this.tradeRepository.findInstrumentId(
      request.symbol,
      request.exchange,
      request.token,
    );

    if (!instrumentId) {
      throw new HttpException(
        `Instrument not found: ${request.symbol} on ${request.exchange}`,
        HttpStatus.NOT_FOUND,
      );
    }

    // ---- STEP 4: Place order ----
    const orderRequest: OrderRequest = {
      symbol: request.symbol,
      token: request.token,
      exchange: request.exchange,
      side: request.side,
      orderType: request.orderType,
      quantity: request.quantity,
      price: request.price,
      triggerPrice: request.triggerPrice,
      positionType: request.positionType,
    };

    let orderId: string | undefined;
    let initialStatus = 'PENDING';
    let entryPrice: number | undefined;
    let entryTime: Date | undefined;

    if (isPaperTrade) {
      // Paper trading — simulate the order
      const paperResponse =
        await this.paperTradeService.simulateOrder(orderRequest);
      orderId = paperResponse.orderId;

      if (paperResponse.status === 'FILLED') {
        initialStatus = 'OPEN';
        entryPrice = request.price ?? request.triggerPrice;
        entryTime = new Date();
      }

      this.logger.log(
        `[Paper] Order ${orderId}: ${paperResponse.status} — ${paperResponse.message}`,
      );
    } else {
      // Real trading — place via broker adapter
      if (!this.brokerAdapter) {
        throw new HttpException(
          'No broker adapter configured — cannot place real orders',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      const response = await this.brokerAdapter.placeOrder(orderRequest);
      orderId = response.orderId;

      this.logger.log(
        `[Live] Order ${orderId}: ${response.status} — ${response.message}`,
      );
    }

    // ---- STEP 4b: Capture market context snapshot ----
    // Tolerant: a snapshot failure must NOT block the trade. The service
    // already swallows individual upstream failures and returns nulls; we
    // wrap one more time defensively so a totally broken context capture
    // (e.g. exception thrown before Promise.all even resolves) still lets
    // the trade record persist.
    const underlying = deriveUnderlying(request.symbol);
    let context: Awaited<ReturnType<MarketContextService['snapshot']>> | null = null;
    try {
      context = await this.marketContextService.snapshot(underlying);
    } catch (err) {
      this.logger.warn(
        `Market context snapshot failed for ${underlying}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }

    // ---- STEP 5: Create trade record in DB ----
    const trade = await this.tradeRepository.createTrade({
      instrumentId,
      signalId: request.signalId ?? undefined,
      orderId,
      side: request.side,
      orderType: request.orderType,
      positionType: request.positionType,
      quantity: request.quantity,
      entryPrice,
      stoploss: request.stoploss,
      target: request.target,
      status: initialStatus,
      strategy: request.strategy,
      isPaperTrade,
      entryTime,
      entryReason: request.entryReason ?? null,
      entryTags: request.entryTags ?? [],
      spotAtEntry: context?.spot ?? null,
      vixAtEntry: context?.vix ?? null,
      vixRegimeAtEntry: context?.vixRegime ?? null,
      pcrAtEntry: context?.pcr ?? null,
      maxPainAtEntry: context?.maxPain ?? null,
      adRatioAtEntry: context?.adRatio ?? null,
      contextSnapshot: context
        ? ({
            ...context,
            capturedAt: context.capturedAt.toISOString(),
          } as unknown as Prisma.InputJsonValue)
        : null,
    });

    // ---- STEP 6: Start order tracking ----
    if (!isPaperTrade && orderId) {
      this.orderTrackerService.trackOrder(
        orderId,
        trade.id,
        request.stoploss,
        orderRequest,
      );
    }

    // If paper trade filled immediately, add to position manager
    if (isPaperTrade && initialStatus === 'OPEN' && entryPrice) {
      this.positionManagerService.addPosition(trade.id, {
        symbol: request.symbol,
        token: request.token,
        exchange: request.exchange,
        side: request.side,
        quantity: request.quantity,
        averagePrice: entryPrice,
        positionType: request.positionType,
      });
    }

    // ---- STEP 7: Emit trade event via WebSocket ----
    this.tradeGateway.emitTradeUpdate(trade);

    this.logger.log(
      `Trade created: ${trade.id} (${isPaperTrade ? 'PAPER' : 'LIVE'}) — ${initialStatus}`,
    );

    return trade;
  }

  /**
   * Close an open trade by placing an opposite order.
   *
   * Accepts either the legacy `string` (for back-compat with existing
   * call sites like the kill-switch) or the structured M5 close-options
   * object: `{exitReasonTag, exitNotes, reason?}`.
   */
  async closeTrade(
    tradeId: string,
    reasonOrOpts?:
      | string
      | {
          exitReasonTag?: ExitReasonTag | string | null;
          exitNotes?: string | null;
          reason?: string | null;
        },
  ): Promise<Trade> {
    const opts =
      typeof reasonOrOpts === 'string'
        ? { reason: reasonOrOpts }
        : reasonOrOpts ?? {};

    const trade = await this.tradeRepository.getTradeById(tradeId);
    if (!trade) {
      throw new HttpException('Trade not found', HttpStatus.NOT_FOUND);
    }

    if (trade.status !== 'OPEN' && trade.status !== 'PARTIALLY_FILLED') {
      throw new HttpException(
        `Cannot close trade with status: ${trade.status}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const instrument = (trade as any).instrument;
    const exitSide = trade.side === 'BUY' ? 'SELL' : 'BUY';

    const closeOrder: OrderRequest = {
      symbol: instrument?.symbol ?? '',
      token: instrument?.token ?? '',
      exchange: instrument?.exchange ?? '',
      side: exitSide as 'BUY' | 'SELL',
      orderType: 'MARKET',
      quantity: trade.quantity,
      positionType: trade.positionType as
        | 'INTRADAY'
        | 'DELIVERY'
        | 'CARRYFORWARD',
    };

    let exitPrice = 0;

    if (trade.isPaperTrade) {
      const paperResponse =
        await this.paperTradeService.simulateOrder(closeOrder);
      // For paper trades, use the LTP or entry price as base
      exitPrice = instrument
        ? (await this.getLastPrice(instrument.token, instrument.exchange)) ?? trade.entryPrice ?? 0
        : trade.entryPrice ?? 0;

      this.logger.log(
        `[Paper] Close order ${paperResponse.orderId}: ${paperResponse.status}`,
      );
    } else {
      if (!this.brokerAdapter) {
        throw new HttpException(
          'No broker adapter configured',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      const response = await this.brokerAdapter.placeOrder(closeOrder);
      this.logger.log(
        `[Live] Close order ${response.orderId}: ${response.status}`,
      );

      // For live trades, fetch the actual LTP
      if (instrument) {
        try {
          const quote = await this.brokerAdapter.getLiveQuote(
            instrument.symbol,
            instrument.exchange,
          );
          exitPrice = quote.ltp;
        } catch {
          exitPrice = trade.entryPrice ?? 0;
        }
      }
    }

    // Calculate P&L
    const entryPrice = trade.entryPrice ?? 0;
    const multiplier = trade.side === 'BUY' ? 1 : -1;
    const pnl = multiplier * (exitPrice - entryPrice) * trade.quantity;
    const pnlPercent =
      entryPrice > 0
        ? (pnl / (entryPrice * trade.quantity)) * 100
        : 0;

    // Pick the human-readable note: prefer structured exitNotes, fall back
    // to the legacy `reason` string (kill-switch path), preserve original
    // notes otherwise.
    const exitNote =
      opts.exitNotes ?? opts.reason ?? null;
    const noteForLegacyField = opts.reason
      ? `Closed: ${opts.reason}`
      : trade.notes ?? undefined;

    // Update trade record
    const updatedTrade = await this.tradeRepository.updateTrade(tradeId, {
      status: 'CLOSED',
      exitPrice,
      exitTime: new Date(),
      pnl,
      pnlPercent,
      notes: noteForLegacyField,
      exitReasonTag: opts.exitReasonTag ?? null,
      exitNotes: exitNote,
    });

    // Remove from position manager
    this.positionManagerService.removePosition(tradeId, pnl);

    // Emit updates
    this.tradeGateway.emitTradeUpdate(updatedTrade);

    this.logger.log(
      `Trade ${tradeId} closed. P&L: ${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)`,
    );

    return updatedTrade;
  }

  /**
   * KILL SWITCH: Close ALL open positions immediately with market orders.
   */
  async closeAllPositions(reason: string): Promise<{ closed: number }> {
    this.logger.error(`CLOSE ALL POSITIONS: ${reason}`);

    // Activate kill switch to block new trades
    this.riskManagerService.activateKillSwitch(reason);

    // Notify settings service
    await this.settingsService.activateKillSwitch();

    // Emit kill switch event
    this.tradeGateway.emitKillSwitchActivated(reason);

    // Close every open trade
    const openTrades = await this.tradeRepository.getOpenTrades();
    let closed = 0;

    for (const trade of openTrades) {
      try {
        await this.closeTrade(trade.id, `Kill switch: ${reason}`);
        closed++;
      } catch (error) {
        this.logger.error(
          `Failed to close trade ${trade.id}: ${error.message}`,
        );
      }
    }

    this.logger.error(
      `Kill switch executed: ${closed}/${openTrades.length} positions closed`,
    );

    // Emit updated risk status
    const riskStatus = await this.riskManagerService.getDailyRiskStatus();
    this.tradeGateway.emitRiskStatus(riskStatus);

    return { closed };
  }

  /**
   * Modify an open trade's stoploss, target, or quantity.
   */
  async modifyTrade(
    tradeId: string,
    updates: ModifyTradeDto,
  ): Promise<Trade> {
    const trade = await this.tradeRepository.getTradeById(tradeId);
    if (!trade) {
      throw new HttpException('Trade not found', HttpStatus.NOT_FOUND);
    }

    if (trade.status !== 'OPEN' && trade.status !== 'PARTIALLY_FILLED') {
      throw new HttpException(
        `Cannot modify trade with status: ${trade.status}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const updateData: Record<string, any> = {};

    if (updates.stoploss !== undefined) {
      updateData.stoploss = updates.stoploss;
    }
    if (updates.target !== undefined) {
      updateData.target = updates.target;
    }
    if (updates.quantity !== undefined) {
      updateData.quantity = updates.quantity;
    }

    if (Object.keys(updateData).length === 0) {
      throw new HttpException(
        'No fields to update',
        HttpStatus.BAD_REQUEST,
      );
    }

    // If live trade and broker adapter available, try to modify the broker order
    if (!trade.isPaperTrade && this.brokerAdapter && trade.orderId) {
      try {
        await this.brokerAdapter.modifyOrder(trade.orderId, {
          price: updates.stoploss,
          quantity: updates.quantity,
        });
      } catch (error) {
        this.logger.warn(
          `Failed to modify broker order ${trade.orderId}: ${error.message}`,
        );
      }
    }

    const updatedTrade = await this.tradeRepository.updateTrade(
      tradeId,
      updateData,
    );

    this.tradeGateway.emitTradeUpdate(updatedTrade);

    this.logger.log(
      `Trade ${tradeId} modified: ${JSON.stringify(updateData)}`,
    );

    return updatedTrade;
  }

  /**
   * Get all currently open trades.
   */
  async getOpenTrades(): Promise<Trade[]> {
    return this.tradeRepository.getOpenTrades();
  }

  /**
   * Get paginated trade history with filters.
   */
  async getTradeHistory(
    filters: TradeFilterDto,
  ): Promise<{ trades: Trade[]; total: number }> {
    return this.tradeRepository.getTradeHistory(filters);
  }

  /**
   * Get a single trade by ID.
   */
  async getTradeById(tradeId: string): Promise<Trade> {
    const trade = await this.tradeRepository.getTradeById(tradeId);
    if (!trade) {
      throw new HttpException('Trade not found', HttpStatus.NOT_FOUND);
    }
    return trade;
  }

  /**
   * Handle incoming tick data — routes to paper trade simulator and position manager.
   */
  handleTick(tick: TickData): void {
    this.paperTradeService.simulateTick(tick);
    this.positionManagerService.updatePositionPnL(tick);
  }

  // ------------------------------------------------------------------
  //  Private helpers
  // ------------------------------------------------------------------

  private async getLastPrice(
    token: string,
    exchange: string,
  ): Promise<number | null> {
    try {
      if (this.brokerAdapter) {
        const quote = await this.brokerAdapter.getLiveQuote(token, exchange);
        return quote.ltp;
      }
    } catch {
      // Fallback: no live price available
    }
    return null;
  }
}
