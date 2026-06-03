import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

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
      where: { status: 'WATCHING' },
      orderBy: { enteredAt: 'desc' },
    });
  }

  async listWatchingSwing() {
    return this.prisma.swingEntry.findMany({
      where: { status: 'WATCHING' },
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

  async expireAllWatchingIntraday(): Promise<number> {
    const result = await this.prisma.intradayEntry.updateMany({
      where: { status: 'WATCHING' },
      data: { status: 'EXPIRED', exitedAt: new Date() },
    });
    return result.count;
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
      if (rows.length === 0) return { avgExitPct: 0, count: 0, winCount: 0 };
      let sum = 0;
      let wins = 0;
      for (const r of rows) {
        const pct = ((r.exitPrice! - r.entryPrice) / r.entryPrice) * 100;
        sum += pct;
        if (pct > 0) wins++;
      }
      return { avgExitPct: sum / rows.length, count: rows.length, winCount: wins };
    };

    return {
      daily: compute(exits.filter(r => r.exitedAt! >= istMidnightDaysAgo(1))),
      weekly: compute(exits.filter(r => r.exitedAt! >= istMidnightDaysAgo(7))),
      monthly: compute(exits.filter(r => r.exitedAt! >= istMidnightDaysAgo(30))),
      yearly: compute(exits),
    };
  }
}
