import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  BadRequestException,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { WatchStatus } from '@prisma/client';
import { WatchRepository } from '../repositories/watch.repository';
import { WatchService, MAX_INVESTMENT_PER_TRADE } from '../services/watch.service';
import { RiskGuardService } from '../services/risk-guard.service';
import { ExecuteWatchDto } from '../dto/execute-watch.dto';
import { CloseWatchDto } from '../dto/close-watch.dto';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';

@Controller('api/watch')
export class WatchController {
  private readonly logger = new Logger(WatchController.name);

  constructor(
    private readonly repo: WatchRepository,
    private readonly watch: WatchService,
    private readonly trade: TradeExecutionService,
    private readonly riskGuard: RiskGuardService,
  ) {}

  @Get()
  async list(@Query('status') status?: string, @Query('limit') limit?: string) {
    const lim = limit
      ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)
      : 50;
    if (status && !(status in WatchStatus)) {
      throw new BadRequestException(`Invalid status: ${status}`);
    }
    return this.repo.list({
      status: status ? (status as WatchStatus) : undefined,
      limit: lim,
    });
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const entry = await this.repo.findByIdWithEvents(id);
    if (!entry) throw new NotFoundException(`WatchEntry ${id} not found`);
    return entry;
  }

  @Post(':id/execute')
  @HttpCode(HttpStatus.OK)
  async execute(@Param('id') id: string, @Body() body: ExecuteWatchDto) {
    const entry = await this.repo.findById(id);
    if (!entry) throw new NotFoundException(`WatchEntry ${id} not found`);
    if (entry.status !== WatchStatus.WATCHING) {
      throw new BadRequestException(
        `Cannot execute on entry in status ${entry.status}`,
      );
    }

    this.logger.log(
      `Executing watch entry ${id} in mode=${body.mode} (paper/live governed by system settings)`,
    );

    // Quantity selection:
    //   - F&O options leg present → lotCount × lotSize (e.g., 1 × 175 = 175 NIFTY units)
    //   - Equity intraday (no options leg) → floor(MAX_INVESTMENT_PER_TRADE / price).
    //     A ₹100 stock → 2000 shares; a ₹7500 stock → 26 shares.
    //     Math.max(1, ...) guards against pathological high-price edge cases.
    //     Callers can always override with body.quantity.
    const optionsLotSize = (entry as any).optionsLotSize ?? null;
    const lotCount = (entry.initialBreakdown as any)?.lotCount ?? 1;
    // Reference price for sizing: current live price preferred, else initial entry.
    const referencePrice = (entry as any).currentPrice ?? entry.initialPrice;
    const computedQty = optionsLotSize
      ? lotCount * optionsLotSize
      : Math.max(1, Math.floor(MAX_INVESTMENT_PER_TRADE / Math.max(referencePrice, 1)));
    const qty = body.quantity ?? computedQty;

    // ExecuteTradeDto requires: symbol, token, exchange, side, orderType,
    // quantity, positionType. Optional: stoploss, target, price, triggerPrice.
    // NOTE: 'mode' is NOT part of ExecuteTradeDto — the service reads isPaperTrade
    // from the system settings. The mode field on ExecuteWatchDto is recorded
    // in this log and can be used by the caller to change settings beforehand.
    const trade = await this.trade.executeTrade({
      symbol: (entry as any).optionsToken
        ? (entry as any).optionsToken
        : entry.symbol,
      token: (entry as any).optionsToken ?? entry.symbol,
      exchange: (entry as any).exchange ?? 'NSE',
      side: entry.side as any,
      quantity: qty,
      orderType: 'MARKET' as any,
      positionType: 'INTRADAY' as any,
      stoploss: (entry as any).stopLoss ?? undefined,
      target: (entry as any).profitTarget ?? undefined,
    } as any);

    await this.repo.update(id, {
      status: WatchStatus.TRADED,
      executedAt: new Date(),
      executedPrice:
        (trade as any).entryPrice ??
        (entry as any).currentPrice ??
        (entry as any).initialPrice,
      paperTradeId:
        body.mode === 'paper' ? (trade as any).id : null,
      liveTradeId:
        body.mode === 'live' ? (trade as any).id : null,
    });

    return { trade, entryId: id };
  }

  @Post(':id/dismiss')
  @HttpCode(HttpStatus.OK)
  async dismiss(@Param('id') id: string) {
    const entry = await this.repo.findById(id);
    if (!entry) throw new NotFoundException(`WatchEntry ${id} not found`);
    await this.watch.dismiss(id);
    return { ok: true };
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  async close(@Param('id') id: string, @Body() body: CloseWatchDto) {
    const entry = await this.repo.findById(id);
    if (!entry) throw new NotFoundException(`WatchEntry ${id} not found`);
    if (entry.status !== WatchStatus.TRADED) {
      throw new BadRequestException(
        `Cannot close entry in status ${entry.status}`,
      );
    }
    await this.repo.update(id, {
      status: WatchStatus.EXITED,
      closedAt: new Date(),
      closedReason: body.reason,
    });
    return { ok: true };
  }

  /**
   * Manual kill switch — squares off every active WATCHING and TRADED entry.
   * Called by the UI's emergency kill-switch button.
   * POST /api/watch/square-off-all
   */
  @Post('square-off-all')
  @HttpCode(HttpStatus.OK)
  async squareOffAll(@Body() body: { reason?: string }) {
    const reason = (body?.reason ?? 'manual') as 'eod-square-off' | 'daily-loss-breaker' | 'manual';
    const result = await this.watch.squareOffAll(reason);
    return result;
  }

  /**
   * Live daily P&L across all TRADED entries executed today (IST date).
   * Used by the UI to display running P&L and the risk-guard breaker status.
   * GET /api/watch/daily-pnl
   */
  @Get('daily-pnl')
  async dailyPnL() {
    return this.riskGuard.computeDailyPnL();
  }
}
