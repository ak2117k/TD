import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Trade, DailyPerformance } from '@prisma/client';
import { TradeFilterDto, DailyPerformanceData } from '../dto/trade.dto';

@Injectable()
export class TradeRepository {
  private readonly logger = new Logger(TradeRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async createTrade(data: {
    instrumentId: string;
    signalId?: string;
    orderId?: string;
    side: string;
    orderType: string;
    positionType: string;
    quantity: number;
    entryPrice?: number;
    stoploss?: number;
    target?: number;
    status: string;
    strategy?: string;
    isPaperTrade: boolean;
    entryTime?: Date;
    notes?: string;
  }): Promise<Trade> {
    return this.prisma.trade.create({ data });
  }

  async updateTrade(
    id: string,
    data: Partial<{
      orderId: string;
      entryPrice: number;
      exitPrice: number;
      stoploss: number;
      target: number;
      pnl: number;
      pnlPercent: number;
      fees: number;
      status: string;
      quantity: number;
      entryTime: Date;
      exitTime: Date;
      notes: string;
    }>,
  ): Promise<Trade> {
    return this.prisma.trade.update({
      where: { id },
      data,
    });
  }

  async getOpenTrades(): Promise<Trade[]> {
    return this.prisma.trade.findMany({
      where: {
        status: { in: ['OPEN', 'PARTIALLY_FILLED'] },
      },
      include: { instrument: true, signal: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getTradeById(id: string): Promise<Trade | null> {
    return this.prisma.trade.findUnique({
      where: { id },
      include: { instrument: true, signal: true },
    });
  }

  async getTradeHistory(
    filters: TradeFilterDto,
  ): Promise<{ trades: Trade[]; total: number }> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.strategy) {
      where.strategy = filters.strategy;
    }
    if (filters.isPaperTrade !== undefined) {
      where.isPaperTrade = filters.isPaperTrade;
    }
    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) where.createdAt.gte = new Date(filters.from);
      if (filters.to) where.createdAt.lte = new Date(filters.to);
    }

    const [trades, total] = await Promise.all([
      this.prisma.trade.findMany({
        where,
        include: { instrument: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.trade.count({ where }),
    ]);

    return { trades, total };
  }

  async getTodayTrades(): Promise<Trade[]> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    return this.prisma.trade.findMany({
      where: {
        createdAt: { gte: todayStart },
      },
      include: { instrument: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getDailyPnL(date: Date): Promise<number> {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const result = await this.prisma.trade.aggregate({
      where: {
        status: 'CLOSED',
        exitTime: { gte: dayStart, lte: dayEnd },
      },
      _sum: { pnl: true },
    });

    return result._sum.pnl ?? 0;
  }

  async saveDailyPerformance(
    data: DailyPerformanceData,
  ): Promise<DailyPerformance> {
    return this.prisma.dailyPerformance.upsert({
      where: { date: data.date },
      update: {
        totalPnl: data.totalPnl,
        realizedPnl: data.realizedPnl,
        unrealizedPnl: data.unrealizedPnl,
        totalTrades: data.totalTrades,
        winningTrades: data.winningTrades,
        losingTrades: data.losingTrades,
        maxDrawdown: data.maxDrawdown,
        capitalDeployed: data.capitalDeployed,
      },
      create: {
        date: data.date,
        totalPnl: data.totalPnl,
        realizedPnl: data.realizedPnl,
        unrealizedPnl: data.unrealizedPnl,
        totalTrades: data.totalTrades,
        winningTrades: data.winningTrades,
        losingTrades: data.losingTrades,
        maxDrawdown: data.maxDrawdown,
        capitalDeployed: data.capitalDeployed,
      },
    });
  }

  /**
   * Find instrument by symbol+exchange, or by token.
   * Returns the instrumentId needed for trade creation.
   */
  async findInstrumentId(
    symbol: string,
    exchange: string,
    token: string,
  ): Promise<string | null> {
    const instrument = await this.prisma.instrument.findFirst({
      where: {
        OR: [
          { symbol, exchange },
          { token, exchange },
        ],
      },
      select: { id: true },
    });
    return instrument?.id ?? null;
  }
}
