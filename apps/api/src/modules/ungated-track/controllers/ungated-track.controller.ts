import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { WatchStatus } from '@prisma/client';
import { UngatedWatchRepository } from '../repositories/ungated-watch.repository';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import { UngatedPaperAccountService } from '../services/ungated-paper-account.service';
import { UngatedComparisonService } from '../services/ungated-comparison.service';

@ApiTags('Ungated Track (A/B experiment)')
@Controller('api/ungated')
export class UngatedTrackController {
  constructor(
    private readonly watchRepo: UngatedWatchRepository,
    private readonly tradeRepo: UngatedTradeRepository,
    private readonly _account: UngatedPaperAccountService,
    private readonly _comparison: UngatedComparisonService,
  ) {}

  @Get('watch')
  async list(
    @Query('status') status?: WatchStatus,
    @Query('date') date?: string,
  ) {
    const entries = await this.watchRepo.list({ status, date });
    const tradeIds = entries
      .map((e) => e.paperTradeId)
      .filter((x): x is string => !!x);
    const realization = await this.tradeRepo.findRealization(tradeIds);
    return entries.map((e) => {
      const r = e.paperTradeId ? realization.get(e.paperTradeId) : undefined;
      return { ...e, realizedPnl: r?.pnl ?? null, realizedFees: r?.fees ?? null };
    });
  }

  @Get('paper-account')
  async account() {
    const snap = await this._account.snapshot();
    const unrealized = 0; // open positions snapshot can add this later
    return {
      ...snap,
      unrealizedPnl: unrealized,
      equity: snap.cash + snap.deployedCapital + unrealized,
    };
  }

  @Get('comparison')
  async comparison(@Query('date') date: string) {
    return this._comparison.daily(date);
  }
}
