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
    const now = new Date();
    const startOf = (offsetDays: number) => {
      const d = new Date(now);
      d.setDate(d.getDate() - offsetDays);
      d.setHours(0, 0, 0, 0);
      return d;
    };

    const exits = await (track === 'intraday'
      ? this.prisma.intradayEntry.findMany({
          where: {
            status: { in: ['TARGET_HIT', 'STOPPED', 'EXPIRED'] },
            exitedAt: { not: null },
            exitPrice: { not: null },
          },
          select: { exitedAt: true, entryPrice: true, exitPrice: true },
        })
      : this.prisma.swingEntry.findMany({
          where: {
            status: { in: ['TARGET_HIT', 'STOPPED'] },
            exitedAt: { not: null },
            exitPrice: { not: null },
          },
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

    const daily = exits.filter(r => r.exitedAt! >= startOf(1));
    const weekly = exits.filter(r => r.exitedAt! >= startOf(7));
    const monthly = exits.filter(r => r.exitedAt! >= startOf(30));
    const yearly = exits.filter(r => r.exitedAt! >= startOf(365));

    return {
      daily: compute(daily),
      weekly: compute(weekly),
      monthly: compute(monthly),
      yearly: compute(yearly),
    };
  }
}
