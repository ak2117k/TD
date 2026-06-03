import { Body, Controller, Get, NotFoundException, Param, Patch, Query } from '@nestjs/common';
import { AnandDualTrackRepository } from '../repositories/anand-dual-track.repository';
import { ChartinkRepository } from '../../chartink/repositories/chartink.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

@Controller('api/anand')
export class AnandDualTrackController {
  constructor(
    private readonly repo: AnandDualTrackRepository,
    private readonly chartinkRepo: ChartinkRepository,
    private readonly adapter: AngelOneAdapterService,
  ) {}

  @Get('intraday/entries')
  async listIntraday(
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const entries = await this.repo.listIntradayEntries({
      status: status || undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    return this.enrichWithLivePrice(entries);
  }

  @Get('swing/entries')
  async listSwing(
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const entries = await this.repo.listSwingEntries({
      status: status || undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    return this.enrichWithLivePrice(entries);
  }

  @Get('intraday/pnl-summary')
  async intradayPnl() {
    return this.repo.getPnlSummary('intraday');
  }

  @Get('swing/pnl-summary')
  async swingPnl() {
    return this.repo.getPnlSummary('swing');
  }

  @Patch('scanners/:id/category')
  async tagScanner(
    @Param('id') id: string,
    @Body() body: { category: string },
  ) {
    const updated = await this.chartinkRepo.updateScannerCategory(id, body.category);
    if (!updated) throw new NotFoundException(`Scanner ${id} not found`);
    return updated;
  }

  private async enrichWithLivePrice(
    entries: Array<{ id: string; token: string | null; entryPrice: number; targetPct: number; stopPct: number; status: string; [key: string]: unknown }>,
  ) {
    const tokens = [...new Set(entries.map((e) => e.token).filter(Boolean) as string[])];
    const ltpMap = tokens.length
      ? await this.adapter.getLtpsBatch('NSE', tokens).catch(() => new Map<string, number>())
      : new Map<string, number>();

    return entries.map((e) => {
      const currentPrice = (e.token ? ltpMap.get(e.token) : undefined) ?? e.entryPrice;
      const pnlPct = ((currentPrice - e.entryPrice) / e.entryPrice) * 100;
      const targetLeftPct = e.targetPct - pnlPct;
      return { ...e, currentPrice, pnlPct, targetLeftPct };
    });
  }
}
