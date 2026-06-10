import { Body, Controller, Get, NotFoundException, Optional, Param, Patch, Query } from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import { AnandDualTrackRepository } from '../repositories/anand-dual-track.repository';
import { ChartinkRepository } from '../../chartink/repositories/chartink.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { LevelBookService } from '../../signal-generator/services/level-book.service';
import { resolvePriceFields } from '../price-fields';
import { realizedIntradayPnlPct } from '../intraday-pnl';

class UpdateCategoryDto {
  @IsString() @IsNotEmpty() category!: string;
}

@Controller('api/anand')
export class AnandDualTrackController {
  constructor(
    private readonly repo: AnandDualTrackRepository,
    private readonly chartinkRepo: ChartinkRepository,
    private readonly adapter: AngelOneAdapterService,
    @Optional() private readonly levelBook?: LevelBookService,
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
    // Live prices are only needed for OPEN positions; closed rows report their
    // realized exit price below.
    const openTokens = [
      ...new Set(entries.filter((e) => e.exitPrice == null).map((e) => e.token).filter(Boolean) as string[]),
    ];
    const ltpMap = openTokens.length
      ? await this.adapter.getLtpsBatch('NSE', openTokens).catch(() => new Map<string, number>())
      : new Map<string, number>();

    // Secondary fallback: for open-position tokens the live LTP batch dropped
    // (e.g. a stock whose Angel feed went quiet mid-session), seed the price
    // from the level book (candle-derived spot). Only the still-missing tokens
    // are queried, so this is a no-op in the common case. A token that resolves
    // nowhere is left out of both maps → resolvePriceFields marks that row stale
    // rather than faking entryPrice (which read as a misleading 0% P&L).
    const seedMap = new Map<string, number>();
    if (this.levelBook) {
      const missing = openTokens.filter((t) => !ltpMap.has(t));
      await Promise.all(
        missing.map(async (token) => {
          const symbol = entries.find((e) => e.token === token)?.symbol ?? '';
          try {
            const book = await this.levelBook!.lazyLoad(token, 'NSE', symbol);
            const seed = book ? book.spot || book.vwap || book.prevClose || 0 : 0;
            if (seed > 0) seedMap.set(token, seed);
          } catch {
            /* leave unresolved → resolvePriceFields marks the row stale */
          }
        }),
      );
    }

    return entries.map((e) => {
      // Closed positions report realized P&L from their actual exit price —
      // never live-priced, never stale.
      if (e.exitPrice != null) {
        // Blends the booked partial leg with the final-exit leg for intraday
        // partial-booked trades. Swing rows carry no partial fields, so the
        // helper falls back to the plain final-exit %.
        const pnlPct =
          realizedIntradayPnlPct({
            entryPrice: e.entryPrice,
            exitPrice: e.exitPrice as number,
            partialExitPrice: e.partialExitPrice as number | null | undefined,
            partialFraction: e.partialFraction as number | null | undefined,
          }) ?? 0;
        return {
          ...e,
          currentPrice: e.exitPrice,
          pnlPct,
          targetLeftPct: e.targetPct - pnlPct,
          priceStale: false,
          partialBookedAt: (e as { partialBookedAt?: unknown }).partialBookedAt ?? null,
          partialExitPrice: (e as { partialExitPrice?: unknown }).partialExitPrice ?? null,
        };
      }
      return { ...e, ...resolvePriceFields(e, ltpMap, seedMap) };
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
