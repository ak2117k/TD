import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

const NOTIONAL = 200_000;

export interface CreateEntryInput {
  symbol: string;
  token: string | null;
  entryPrice: number;
  alertId: string;
  scoreBreakdown: unknown;
}

export interface UpdateStatusInput {
  status: string;
  exitPrice?: number;
  exitedAt?: Date;
  exitReason?: string;
}

export interface ListEntriesFilter {
  status?: string;
  from?: Date;
  to?: Date;
}

export interface PnlSummaryPeriod {
  avgExitPct: number;
  count: number;
  winCount: number;
  totalPnlRs: number;
}

export interface PnlSummary {
  daily: PnlSummaryPeriod;
  weekly: PnlSummaryPeriod;
  monthly: PnlSummaryPeriod;
  yearly: PnlSummaryPeriod;
}

@Injectable()
export class AnandDualTrackRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createIntradayEntry(input: CreateEntryInput): Promise<{ id: string }> {
    return this.prisma.intradayEntry.create({
      data: {
        symbol: input.symbol,
        token: input.token,
        entryPrice: input.entryPrice,
        alertId: input.alertId,
        targetPct: 5,
        stopPct: 5,
        scoreBreakdown:
          input.scoreBreakdown == null
            ? Prisma.JsonNull
            : (input.scoreBreakdown as Prisma.InputJsonValue),
      },
      select: { id: true },
    });
  }

  async createSwingEntry(input: CreateEntryInput): Promise<{ id: string }> {
    return this.prisma.swingEntry.create({
      data: {
        symbol: input.symbol,
        token: input.token,
        entryPrice: input.entryPrice,
        alertId: input.alertId,
        targetPct: 10,
        stopPct: 10,
        scoreBreakdown:
          input.scoreBreakdown == null
            ? Prisma.JsonNull
            : (input.scoreBreakdown as Prisma.InputJsonValue),
      },
      select: { id: true },
    });
  }

  async listWatchingIntraday() {
    return this.prisma.intradayEntry.findMany({
      where: { status: 'TRADED' },
      orderBy: { enteredAt: 'desc' },
    });
  }

  async listWatchingSwing() {
    return this.prisma.swingEntry.findMany({
      where: { status: 'TRADED' },
      orderBy: { enteredAt: 'desc' },
    });
  }

  async listIntradayEntries(filter: ListEntriesFilter = {}) {
    return this.prisma.intradayEntry.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.from || filter.to
          ? {
              enteredAt: {
                ...(filter.from ? { gte: filter.from } : {}),
                ...(filter.to ? { lte: filter.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { enteredAt: 'desc' },
      take: 200,
    });
  }

  async listSwingEntries(filter: ListEntriesFilter = {}) {
    return this.prisma.swingEntry.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.from || filter.to
          ? {
              enteredAt: {
                ...(filter.from ? { gte: filter.from } : {}),
                ...(filter.to ? { lte: filter.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { enteredAt: 'desc' },
      take: 200,
    });
  }

  async updateIntradayStatus(id: string, data: UpdateStatusInput): Promise<void> {
    await this.prisma.intradayEntry.update({ where: { id }, data });
  }

  async updateSwingStatus(id: string, data: UpdateStatusInput): Promise<void> {
    await this.prisma.swingEntry.update({ where: { id }, data });
  }

  async setIntradayTrailing(id: string, data: { trailing: boolean; peakPrice: number }): Promise<void> {
    await this.prisma.intradayEntry.update({ where: { id }, data });
  }

  async findActiveTradedBySymbol(
    track: 'intraday' | 'swing',
    symbol: string,
  ): Promise<{ id: string } | null> {
    const model = track === 'intraday' ? this.prisma.intradayEntry : this.prisma.swingEntry;
    return (model as any).findFirst({
      where: { symbol, status: 'TRADED' },
      select: { id: true },
    });
  }

  /** IST midnight of the current day, returned as a UTC Date. */
  private istMidnightTodayUtc(): Date {
    const now = new Date();
    const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    istNow.setUTCHours(0, 0, 0, 0);
    return new Date(istNow.getTime() - 5.5 * 60 * 60 * 1000);
  }

  /** True if the symbol already hit its target today (IST) on the given track. */
  async hasTargetHitTodayBySymbol(
    track: 'intraday' | 'swing',
    symbol: string,
  ): Promise<boolean> {
    const model = track === 'intraday' ? this.prisma.intradayEntry : this.prisma.swingEntry;
    const hit = await (model as any).findFirst({
      where: { symbol, status: 'TARGET_HIT', exitedAt: { gte: this.istMidnightTodayUtc() } },
      select: { id: true },
    });
    return hit != null;
  }

  /**
   * Record one "lead" occurrence for a symbol+track. Increments count and
   * appends the current ISO timestamp to the lossless `dates` log. Called on
   * EVERY scanner fire — even when no new entry is created — so the count is
   * true lead frequency.
   */
  async bumpLeadStat(track: 'swing' | 'intraday', symbol: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const existing = await this.prisma.symbolLeadStat.findFirst({
      where: { symbol, track },
      select: { dates: true },
    });
    const dates = Array.isArray(existing?.dates) ? (existing!.dates as string[]) : [];
    await this.prisma.symbolLeadStat.upsert({
      where: { symbol_track: { symbol, track } },
      create: { symbol, track, count: 1, dates: [nowIso], lastLedAt: new Date() },
      update: { count: { increment: 1 }, dates: [...dates, nowIso], lastLedAt: new Date() },
    });
  }

  /** Map symbol → { count, dates } for the given symbols on a track. */
  async getLeadStats(
    track: 'swing' | 'intraday',
    symbols: string[],
  ): Promise<Map<string, { count: number; dates: string[] }>> {
    const out = new Map<string, { count: number; dates: string[] }>();
    if (symbols.length === 0) return out;
    const rows = await this.prisma.symbolLeadStat.findMany({
      where: { track, symbol: { in: [...new Set(symbols)] } },
      select: { symbol: true, count: true, dates: true },
    });
    for (const r of rows) {
      out.set(r.symbol, { count: r.count, dates: Array.isArray(r.dates) ? (r.dates as string[]) : [] });
    }
    return out;
  }

  // ── Reinvestment (Feature 4) ─────────────────────────────────────────────
  async createReinvestmentLot(input: {
    symbol: string;
    sourceSwingEntryId: string;
    capital: number;
    entryPrice: number;
  }): Promise<{ id: string } | null> {
    // sourceSwingEntryId is @unique — a duplicate create (re-poll) throws P2002;
    // swallow it so the lot is created at most once per swing target hit.
    try {
      return await this.prisma.reinvestmentLot.create({
        data: { ...input, targetPct: 10, stopPct: 10, status: 'OPEN' },
        select: { id: true },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') return null;
      throw err;
    }
  }

  async listOpenReinvestmentLots() {
    return this.prisma.reinvestmentLot.findMany({ where: { status: 'OPEN' }, orderBy: { enteredAt: 'desc' } });
  }

  async listReinvestmentLots(status?: string) {
    return this.prisma.reinvestmentLot.findMany({
      where: status ? { status } : {},
      orderBy: { enteredAt: 'desc' },
      take: 200,
    });
  }

  async closeReinvestmentLot(
    id: string,
    data: { status: string; exitPrice: number; exitedAt: Date; exitReason: string },
  ): Promise<void> {
    await this.prisma.reinvestmentLot.update({ where: { id }, data });
  }

  async getPool() {
    return this.prisma.reinvestmentPool.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton' },
      update: {},
    });
  }

  async applyPoolDelta(delta: {
    harvestedTotal?: number;
    deployedActive?: number;
    idleBalance?: number;
    realizedPnl?: number;
  }): Promise<void> {
    await this.prisma.reinvestmentPool.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        harvestedTotal: delta.harvestedTotal ?? 0,
        deployedActive: delta.deployedActive ?? 0,
        idleBalance: delta.idleBalance ?? 0,
        realizedPnl: delta.realizedPnl ?? 0,
      },
      update: {
        harvestedTotal: { increment: delta.harvestedTotal ?? 0 },
        deployedActive: { increment: delta.deployedActive ?? 0 },
        idleBalance: { increment: delta.idleBalance ?? 0 },
        realizedPnl: { increment: delta.realizedPnl ?? 0 },
      },
    });
  }

  /** Resolve symbol → instrument token using the most recent swing entry token. */
  async resolveTokens(symbols: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (symbols.length === 0) return out;
    const rows = await this.prisma.swingEntry.findMany({
      where: { symbol: { in: [...new Set(symbols)] }, token: { not: null } },
      select: { symbol: true, token: true },
      orderBy: { enteredAt: 'desc' },
    });
    for (const r of rows) {
      if (r.token && !out.has(r.symbol)) out.set(r.symbol, r.token);
    }
    return out;
  }

  async findScannerNamesByAlertIds(alertIds: string[]): Promise<Map<string, string>> {
    if (alertIds.length === 0) return new Map();
    const rows = await this.prisma.chartinkAlert.findMany({
      where: { id: { in: alertIds } },
      select: { id: true, scanner: { select: { scanName: true } } },
    });
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.scanner) map.set(row.id, row.scanner.scanName);
    }
    return map;
  }

  async getPnlSummary(track: 'intraday' | 'swing'): Promise<PnlSummary> {
    // IST midnight N days ago. IST = UTC+05:30; this matches the pattern in
    // UngatedRejectionRepository which pins the offset rather than using the
    // process-local timezone (the server runs UTC in production).
    const istMidnightDaysAgo = (days: number): Date => {
      const now = new Date();
      const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
      istNow.setUTCHours(0, 0, 0, 0);
      istNow.setUTCDate(istNow.getUTCDate() - days);
      return new Date(istNow.getTime() - 5.5 * 60 * 60 * 1000);
    };

    // Fetch only the last year at the DB level — avoids loading the full
    // history into memory on mature datasets.
    const yearStart = istMidnightDaysAgo(365);
    const exitStatuses =
      track === 'intraday'
        ? ['TARGET_HIT', 'STOPPED', 'EXPIRED']
        : ['TARGET_HIT', 'STOPPED'];

    const exits = await (track === 'intraday'
      ? this.prisma.intradayEntry.findMany({
          where: { status: { in: exitStatuses }, exitedAt: { gte: yearStart }, exitPrice: { not: null } },
          select: { exitedAt: true, entryPrice: true, exitPrice: true },
        })
      : this.prisma.swingEntry.findMany({
          where: { status: { in: exitStatuses }, exitedAt: { gte: yearStart }, exitPrice: { not: null } },
          select: { exitedAt: true, entryPrice: true, exitPrice: true },
        }));

    const compute = (rows: typeof exits): PnlSummaryPeriod => {
      if (rows.length === 0) return { avgExitPct: 0, count: 0, winCount: 0, totalPnlRs: 0 };
      let sum = 0;
      let wins = 0;
      let totalPnlRs = 0;
      for (const r of rows) {
        const pct = ((r.exitPrice! - r.entryPrice) / r.entryPrice) * 100;
        sum += pct;
        if (pct > 0) wins++;
        totalPnlRs += (pct / 100) * NOTIONAL;
      }
      return { avgExitPct: sum / rows.length, count: rows.length, winCount: wins, totalPnlRs };
    };

    return {
      daily: compute(exits.filter(r => r.exitedAt! >= istMidnightDaysAgo(1))),
      weekly: compute(exits.filter(r => r.exitedAt! >= istMidnightDaysAgo(7))),
      monthly: compute(exits.filter(r => r.exitedAt! >= istMidnightDaysAgo(30))),
      yearly: compute(exits),
    };
  }
}
