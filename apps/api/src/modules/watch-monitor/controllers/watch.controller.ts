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
import { RiskGuardService } from '../services/risk-guard.service';
import { ExecuteWatchDto } from '../dto/execute-watch.dto';
import { CloseWatchDto } from '../dto/close-watch.dto';

@Controller('api/watch')
export class WatchController {
  private readonly logger = new Logger(WatchController.name);

  constructor(
    private readonly repo: WatchRepository,
    private readonly watch: WatchService,
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
    this.logger.log(
      `Manual execute on watch entry ${id} mode=${body.mode}`,
    );
    try {
      const trade = await this.watch.executeEntry(id, {
        mode: body.mode,
        quantityOverride: body.quantity,
      });
      return { trade, entryId: id };
    } catch (err) {
      // Surface clean HTTP errors. The service throws plain Errors with
      // human-readable messages; map them to 400/404 based on content.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) throw new NotFoundException(msg);
      throw new BadRequestException(msg);
    }
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
