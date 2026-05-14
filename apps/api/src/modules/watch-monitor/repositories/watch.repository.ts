import { Injectable } from '@nestjs/common';
import { Prisma, WatchEntry, WatchEvent, WatchEventType, WatchStatus } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

export interface CreateEntryInput {
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
  optionsToken?: string | null;
  optionsType?: 'CE' | 'PE' | null;
  optionsExpiry?: Date | null;
  optionsStrike?: number | null;
  optionsLotSize?: number | null;
  optionsSelectionScore?: number | null;
}

export interface CreateEventInput {
  watchEntryId: string;
  eventType: WatchEventType;
  price?: number | null;
  score?: number | null;
  breakdown?: Prisma.InputJsonValue | null;
  priceDelta?: number | null;
  scoreDelta?: number | null;
  notes?: string | null;
}

@Injectable()
export class WatchRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createEntry(input: CreateEntryInput): Promise<WatchEntry> {
    return this.prisma.watchEntry.create({
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
        optionsToken: input.optionsToken ?? null,
        optionsType: input.optionsType ?? null,
        optionsExpiry: input.optionsExpiry ?? null,
        optionsStrike: input.optionsStrike ?? null,
        optionsLotSize: input.optionsLotSize ?? null,
        optionsSelectionScore: input.optionsSelectionScore ?? null,
      },
    });
  }

  async createEvent(input: CreateEventInput): Promise<WatchEvent> {
    return this.prisma.watchEvent.create({
      data: {
        watchEntryId: input.watchEntryId,
        eventType: input.eventType,
        price: input.price ?? null,
        score: input.score ?? null,
        breakdown: input.breakdown == null ? Prisma.JsonNull : input.breakdown,
        priceDelta: input.priceDelta ?? null,
        scoreDelta: input.scoreDelta ?? null,
        notes: input.notes ?? null,
      },
    });
  }

  async findById(id: string): Promise<WatchEntry | null> {
    return this.prisma.watchEntry.findUnique({ where: { id } });
  }

  async findByIdWithEvents(id: string) {
    return this.prisma.watchEntry.findUnique({
      where: { id },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 100 } },
    });
  }

  async findActiveBySetupId(setupId: string): Promise<WatchEntry | null> {
    return this.prisma.watchEntry.findFirst({
      where: { setupId, status: { in: [WatchStatus.WATCHING, WatchStatus.TRADED] } },
    });
  }

  async findAllActive(): Promise<WatchEntry[]> {
    return this.prisma.watchEntry.findMany({
      where: { status: { in: [WatchStatus.WATCHING, WatchStatus.TRADED] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async list(opts: { status?: WatchStatus; limit?: number }): Promise<WatchEntry[]> {
    const where: Prisma.WatchEntryWhereInput = {};
    if (opts.status) where.status = opts.status;
    return this.prisma.watchEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: opts.limit ?? 50,
    });
  }

  async findActiveByToken(token: string): Promise<WatchEntry[]> {
    return this.prisma.watchEntry.findMany({
      where: {
        status: { in: [WatchStatus.WATCHING, WatchStatus.TRADED] },
        OR: [{ token }, { optionsToken: token }],
      },
    });
  }

  async countActive(): Promise<number> {
    return this.prisma.watchEntry.count({
      where: { status: { in: [WatchStatus.WATCHING, WatchStatus.TRADED] } },
    });
  }

  /**
   * All TRADED entries that were executed today (IST date). Used by
   * RiskGuardService to compute the running daily P&L.
   */
  async findTradedToday(): Promise<WatchEntry[]> {
    // Compute today's IST midnight as a UTC instant.
    const now = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    const istMidnight = new Date(
      Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()),
    );
    // The boundary in UTC is IST midnight - 5h30m
    const utcStart = new Date(istMidnight.getTime() - istOffsetMs);
    return this.prisma.watchEntry.findMany({
      where: {
        status: WatchStatus.TRADED,
        executedAt: { gte: utcStart },
      },
    });
  }

  /**
   * All entries that are currently WATCHING or TRADED. Used by square-off
   * to find everything that needs to be closed.
   */
  async findAllActiveOrTraded(): Promise<WatchEntry[]> {
    return this.prisma.watchEntry.findMany({
      where: { status: { in: [WatchStatus.WATCHING, WatchStatus.TRADED] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(id: string, data: Prisma.WatchEntryUpdateInput): Promise<WatchEntry> {
    return this.prisma.watchEntry.update({ where: { id }, data });
  }
}
