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
import { WatchService } from '../services/watch.service';
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

    const lotCount = (entry.initialBreakdown as any)?.lotCount ?? 1;
    const lotSize = (entry as any).optionsLotSize ?? 1;
    const qty = body.quantity ?? lotCount * lotSize;

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
}
