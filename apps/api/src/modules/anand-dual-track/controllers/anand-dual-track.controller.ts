import { Body, Controller, Get, NotFoundException, Param, Patch, Query } from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import { AnandDualTrackRepository } from '../repositories/anand-dual-track.repository';
import { ChartinkRepository } from '../../chartink/repositories/chartink.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

class UpdateCategoryDto {
  @IsString() @IsNotEmpty() category!: string;
}

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
    const enriched = await this.enrichWithLivePrice(entries);
    return this.enrichWithScannerName(enriched);
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
    const enriched = await this.enrichWithLivePrice(entries);
    const withScanner = await this.enrichWithScannerName(enriched);
    const leadMap = await this.repo
      .getLeadStats('swing', withScanner.map((e) => e.symbol as string))
      .catch(() => new Map<string, { count: number; dates: string[] }>());
    return withScanner.map((e) => {
      const lead = leadMap.get(e.symbol as string);
      return { ...e, leadCount: lead?.count ?? 0, leadDates: lead?.dates ?? [] };
    });
  }

  @Get('intraday/pnl-summary')
  async intradayPnl() {
    return this.repo.getPnlSummary('intraday');
  }

  @Get('swing/pnl-summary')
  async swingPnl() {
    return this.repo.getPnlSummary('swing');
  }

  @Get('reinvest/pool')
  async reinvestPool() {
    return this.repo.getPool();
  }

  @Get('reinvest/lots')
  async reinvestLots(@Query('status') status?: string) {
    const lots = await this.repo.listReinvestmentLots(status || undefined);
    const tokenMap = await this.repo.resolveTokens(lots.map((l) => l.symbol)).catch(() => new Map<string, string>());
    const tokens = [...new Set([...tokenMap.values()])];
    const ltpMap = tokens.length
      ? await this.adapter.getLtpsBatch('NSE', tokens).catch(() => new Map<string, number>())
      : new Map<string, number>();
    return lots.map((l) => {
      const token = tokenMap.get(l.symbol);
      const currentPrice = (token ? ltpMap.get(token) : undefined) ?? l.exitPrice ?? l.entryPrice;
      const pnlPct = ((currentPrice - l.entryPrice) / l.entryPrice) * 100;
      const pnlRs = (pnlPct / 100) * l.capital;
      return { ...l, currentPrice, pnlPct, pnlRs };
    });
  }

  @Patch('scanners/:id/category')
  async tagScanner(
    @Param('id') id: string,
    @Body() body: UpdateCategoryDto,
  ) {
    const updated = await this.chartinkRepo.updateScannerCategory(id, body.category);
    if (!updated) throw new NotFoundException(`Scanner ${id} not found`);
    return updated;
  }

  private async enrichWithLivePrice(
    entries: Array<{ id: string; symbol: string; token: string | null; entryPrice: number; targetPct: number; stopPct: number; status: string; [key: string]: unknown }>,
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

  private async enrichWithScannerName<T extends { alertId?: string | null; [key: string]: unknown }>(
    entries: T[],
  ): Promise<Array<T & { scannerName: string | null }>> {
    const alertIds = entries.map((e) => e.alertId).filter((id): id is string => !!id);
    const scannerMap = await this.repo.findScannerNamesByAlertIds(alertIds).catch(() => new Map<string, string>());
    return entries.map((e) => ({
      ...e,
      scannerName: (e.alertId ? scannerMap.get(e.alertId) : undefined) ?? null,
    }));
  }
}
