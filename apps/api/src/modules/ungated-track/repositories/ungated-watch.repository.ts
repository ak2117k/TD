import { Injectable } from '@nestjs/common';
import { Prisma, UngatedWatchEntry, WatchEventType, WatchStatus } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

export interface UngatedCreateEntryInput {
  alertId: string | null;
  setupId: string | null;
  symbol: string;
  token: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  initialPrice: number;
  initialScore: number;
  initialBreakdown: Prisma.InputJsonValue;
  profitTarget: number;
  profitTargetSource: 'indicator-sr' | 'fallback-2pct';
  stopLossScore: number;
}

export interface UngatedCreateEventInput {
  watchEntryId: string;
  eventType: WatchEventType;
  price?: number | null;
  score?: number | null;
  breakdown?: Prisma.InputJsonValue | null;
  priceDelta?: number | null;
  scoreDelta?: number | null;
  notes?: string | null;
}

const CLOSED_STATES = [
  WatchStatus.STOPPED,
  WatchStatus.TARGET_HIT,
  WatchStatus.EXITED,
  WatchStatus.DISMISSED,
];

/**
 * MIRROR OF apps/api/src/modules/watch-monitor/repositories/watch.repository.ts
 * Keep correctness changes in sync. See specs/2026-05-20-ungated-shadow-track-design.md.
 *
 * Differences vs gated counterpart:
 *  - No options-leg columns (equity-only experiment)
 *  - No `findScannerNames` / `findTradeRealization` — those live on
 *    ungated-trade.repository.ts + the controller does the join.
 */
@Injectable()
export class UngatedWatchRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createEntry(input: UngatedCreateEntryInput): Promise<UngatedWatchEntry> {
    return this.prisma.ungatedWatchEntry.create({
      data: {
        alertId: input.alertId,
        setupId: input.setupId,
        symbol: input.symbol,
        token: input.token,
        exchange: input.exchange,
        side: input.side,
        initialPrice: input.initialPrice,
        initialScore: input.initialScore,
        initialBreakdown: input.initialBreakdown,
        profitTarget: input.profitTarget,
        profitTargetSource: input.profitTargetSource,
        stopLossScore: input.stopLossScore,
      },
    });
  }

  async createEvent(input: UngatedCreateEventInput) {
    return this.prisma.ungatedWatchEvent.create({
      data: {
        watchEntryId: input.watchEntryId,
        eventType: input.eventType,
        price: input.price ?? null,
        score: input.score ?? null,
        breakdown: (input.breakdown ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        priceDelta: input.priceDelta ?? null,
        scoreDelta: input.scoreDelta ?? null,
        notes: input.notes ?? null,
      },
    });
  }

  async findById(id: string): Promise<UngatedWatchEntry | null> {
    return this.prisma.ungatedWatchEntry.findUnique({ where: { id } });
  }

  async findActiveByToken(token: string): Promise<UngatedWatchEntry[]> {
    return this.prisma.ungatedWatchEntry.findMany({
      where: { token, status: { notIn: CLOSED_STATES } },
    });
  }

  async findAllActive(): Promise<UngatedWatchEntry[]> {
    return this.prisma.ungatedWatchEntry.findMany({
      where: { status: { notIn: CLOSED_STATES } },
    });
  }

  async countActive(): Promise<number> {
    return this.prisma.ungatedWatchEntry.count({
      where: { status: { notIn: CLOSED_STATES } },
    });
  }

  async countOpenTrades(): Promise<number> {
    // "Open" = TRADED (executed and not yet exited).
    return this.prisma.ungatedWatchEntry.count({
      where: { status: WatchStatus.TRADED },
    });
  }

  async wasTokenExecutedSince(token: string, since: Date): Promise<boolean> {
    const n = await this.prisma.ungatedWatchEntry.count({
      where: { token, executedAt: { gte: since } },
    });
    return n > 0;
  }

  async list(opts: { status?: WatchStatus; date?: string }) {
    const where: Prisma.UngatedWatchEntryWhereInput = {};
    if (opts.status) where.status = opts.status;
    if (opts.date) {
      const start = new Date(`${opts.date}T00:00:00.000+05:30`);
      const end = new Date(`${opts.date}T23:59:59.999+05:30`);
      where.createdAt = { gte: start, lte: end };
    }
    return this.prisma.ungatedWatchEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(id: string, data: Prisma.UngatedWatchEntryUpdateInput) {
    return this.prisma.ungatedWatchEntry.update({ where: { id }, data });
  }
}
