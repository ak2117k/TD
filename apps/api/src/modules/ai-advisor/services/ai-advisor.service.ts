import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { firstValueFrom } from 'rxjs';

export interface AIResponse {
  answer: string;
  confidence: number;
  relatedInsights: string[];
  suggestedActions: string[];
}

export interface AIInsightResult {
  id: string;
  type: 'suggestion' | 'warning' | 'analysis' | 'report';
  title: string;
  content: string;
  actionable: boolean;
  createdAt: Date;
}

export interface PerformanceSummaryResult {
  summary: string;
  winRate: number;
  totalPnl: number;
  totalTrades: number;
  bestStrategy: string | null;
  worstStrategy: string | null;
  recentStreak: string;
}

export interface TradingSuggestion {
  id: string;
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  category: string;
}

@Injectable()
export class AIAdvisorService {
  private readonly logger = new Logger(AIAdvisorService.name);
  private readonly aiEngineUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.aiEngineUrl =
      this.configService.get<string>('AI_ENGINE_URL') ||
      'http://localhost:8000';
  }

  /**
   * Send a question to the Python AI engine with trading context
   */
  async askQuestion(question: string): Promise<AIResponse> {
    const context = await this.buildTradingContext();

    try {
      const response = await firstValueFrom(
        this.httpService.post<AIResponse>(
          `${this.aiEngineUrl}/api/ask-advisor`,
          { question, context },
          { timeout: 30000 },
        ),
      );
      return response.data;
    } catch (error) {
      this.logger.error('Failed to reach AI engine for ask-advisor', error);
      return {
        answer:
          'I am unable to connect to the AI engine right now. Please try again in a moment.',
        confidence: 0,
        relatedInsights: [],
        suggestedActions: ['Check that the AI engine is running'],
      };
    }
  }

  /**
   * Generate current insights based on recent trading data
   */
  async getInsights(): Promise<AIInsightResult[]> {
    const insights: AIInsightResult[] = [];
    const now = new Date();

    // Fetch recent trades (last 7 days)
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const recentTrades = await this.prisma.trade.findMany({
      where: { createdAt: { gte: weekAgo }, status: 'CLOSED' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    if (recentTrades.length === 0) {
      insights.push({
        id: 'no-trades',
        type: 'suggestion',
        title: 'No recent trades detected',
        content:
          'Start trading to receive personalized insights and performance analysis from the AI advisor.',
        actionable: false,
        createdAt: now,
      });
      return insights;
    }

    // Win rate insight
    const wins = recentTrades.filter((t) => (t.pnl ?? 0) > 0).length;
    const winRate =
      recentTrades.length > 0
        ? Math.round((wins / recentTrades.length) * 100)
        : 0;

    if (winRate < 40) {
      insights.push({
        id: 'low-winrate',
        type: 'warning',
        title: 'Win rate below 40%',
        content: `Your win rate this week is ${winRate}%. Consider reviewing your entry criteria and risk management. Focus on higher-confidence setups.`,
        actionable: true,
        createdAt: now,
      });
    } else if (winRate > 65) {
      insights.push({
        id: 'high-winrate',
        type: 'analysis',
        title: 'Strong win rate this week',
        content: `Excellent performance with a ${winRate}% win rate across ${recentTrades.length} trades. Keep executing your current approach consistently.`,
        actionable: false,
        createdAt: now,
      });
    }

    // P&L insight
    const totalPnl = recentTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    insights.push({
      id: 'weekly-pnl',
      type: totalPnl >= 0 ? 'analysis' : 'warning',
      title: `Weekly P&L: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`,
      content:
        totalPnl >= 0
          ? `You have earned ${totalPnl.toFixed(2)} this week from ${recentTrades.length} closed trades. Your average win is consistent.`
          : `You are down ${Math.abs(totalPnl).toFixed(2)} this week. Review losing trades for common patterns and consider reducing position sizes.`,
      actionable: totalPnl < 0,
      createdAt: now,
    });

    // Strategy diversity insight
    const strategies = new Set(recentTrades.map((t) => t.strategy).filter(Boolean));
    if (strategies.size === 1) {
      insights.push({
        id: 'single-strategy',
        type: 'suggestion',
        title: 'Diversify your strategies',
        content:
          'All recent trades use a single strategy. Consider exploring other strategies to reduce risk concentration.',
        actionable: true,
        createdAt: now,
      });
    }

    // Losing streak detection
    const sortedTrades = [...recentTrades].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    let losingStreak = 0;
    for (const trade of sortedTrades) {
      if ((trade.pnl ?? 0) < 0) losingStreak++;
      else break;
    }
    if (losingStreak >= 3) {
      insights.push({
        id: 'losing-streak',
        type: 'warning',
        title: `${losingStreak}-trade losing streak`,
        content: `You have ${losingStreak} consecutive losses. Consider pausing to reassess market conditions and your strategy parameters before taking the next trade.`,
        actionable: true,
        createdAt: now,
      });
    }

    return insights;
  }

  /**
   * Deep analysis of a specific trade via the Python AI engine
   */
  async analyzeTrade(tradeId: string) {
    const trade = await this.prisma.trade.findUnique({
      where: { id: tradeId },
      include: { instrument: true, signal: true },
    });

    if (!trade) {
      throw new Error(`Trade ${tradeId} not found`);
    }

    // Fetch recent candles for market context
    const candles = trade.instrument
      ? await this.prisma.candle.findMany({
          where: {
            instrumentId: trade.instrumentId,
            timeframe: '5m',
            timestamp: {
              gte: new Date(
                (trade.entryTime ?? trade.createdAt).getTime() -
                  60 * 60 * 1000,
              ),
              lte: trade.entryTime ?? trade.createdAt,
            },
          },
          orderBy: { timestamp: 'asc' },
          take: 20,
        })
      : [];

    const tradeInput = {
      symbol: trade.instrument?.symbol ?? 'UNKNOWN',
      side: trade.side,
      entry_price: trade.entryPrice ?? 0,
      exit_price: trade.exitPrice ?? 0,
      entry_time: trade.entryTime?.toISOString() ?? '',
      exit_time: trade.exitTime?.toISOString() ?? '',
      pnl: trade.pnl ?? 0,
      strategy: trade.strategy ?? 'unknown',
      stoploss_price: trade.stoploss ?? null,
      target_price: trade.target ?? null,
    };

    const marketContext = {
      candles_at_entry: candles.map((c) => ({
        timestamp: c.timestamp.toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: Number(c.volume),
      })),
      market_regime: 'unknown',
      volume_at_entry: candles.length > 0 ? Number(candles[candles.length - 1].volume) : 0,
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.aiEngineUrl}/api/analyze-trade`,
          { trade: tradeInput, market_context: marketContext },
          { timeout: 30000 },
        ),
      );

      // Store analysis in DB
      await this.prisma.aITradeAnalysis.create({
        data: {
          tradeId,
          analysis: JSON.stringify(response.data.analysis),
          suggestions: JSON.stringify(
            response.data.analysis?.improvement_suggestions ?? [],
          ),
          patterns: JSON.stringify(response.data.patterns_detected ?? []),
          score: response.data.score ?? 0,
        },
      });

      return response.data;
    } catch (error) {
      this.logger.error(`Failed to analyze trade ${tradeId}`, error);
      throw new Error('AI engine is unavailable. Please try again later.');
    }
  }

  /**
   * Natural language summary of recent performance
   */
  async getPerformanceSummary(): Promise<PerformanceSummaryResult> {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const recentTrades = await this.prisma.trade.findMany({
      where: { createdAt: { gte: weekAgo }, status: 'CLOSED' },
      include: { instrument: true },
    });

    const totalPnl = recentTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const wins = recentTrades.filter((t) => (t.pnl ?? 0) > 0).length;
    const winRate =
      recentTrades.length > 0
        ? Math.round((wins / recentTrades.length) * 100)
        : 0;

    // Strategy performance
    const stratMap = new Map<string, { pnl: number; count: number }>();
    for (const t of recentTrades) {
      const strat = t.strategy ?? 'unknown';
      const current = stratMap.get(strat) ?? { pnl: 0, count: 0 };
      current.pnl += t.pnl ?? 0;
      current.count += 1;
      stratMap.set(strat, current);
    }

    let bestStrategy: string | null = null;
    let worstStrategy: string | null = null;
    let bestPnl = -Infinity;
    let worstPnl = Infinity;
    for (const [name, stats] of stratMap) {
      if (stats.pnl > bestPnl) {
        bestPnl = stats.pnl;
        bestStrategy = name;
      }
      if (stats.pnl < worstPnl) {
        worstPnl = stats.pnl;
        worstStrategy = name;
      }
    }

    // Recent streak
    const sorted = [...recentTrades].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    let streak = 0;
    let streakType: 'winning' | 'losing' | 'none' = 'none';
    if (sorted.length > 0) {
      const firstPnl = sorted[0].pnl ?? 0;
      streakType = firstPnl >= 0 ? 'winning' : 'losing';
      for (const t of sorted) {
        const isWin = (t.pnl ?? 0) >= 0;
        if ((streakType === 'winning' && isWin) || (streakType === 'losing' && !isWin)) {
          streak++;
        } else break;
      }
    }

    const summaryParts: string[] = [];
    if (recentTrades.length === 0) {
      summaryParts.push('No trades closed this week yet.');
    } else {
      summaryParts.push(
        `This week you closed ${recentTrades.length} trade${recentTrades.length !== 1 ? 's' : ''} with a ${totalPnl >= 0 ? 'profit' : 'loss'} of ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}.`,
      );
      summaryParts.push(`Your win rate stands at ${winRate}%.`);
      if (bestStrategy && stratMap.size > 1) {
        summaryParts.push(
          `Best performing strategy: ${bestStrategy} (+${bestPnl.toFixed(2)}).`,
        );
      }
      if (streak >= 3) {
        summaryParts.push(
          `You are on a ${streak}-trade ${streakType} streak.`,
        );
      }
    }

    return {
      summary: summaryParts.join(' '),
      winRate,
      totalPnl: Number(totalPnl.toFixed(2)),
      totalTrades: recentTrades.length,
      bestStrategy,
      worstStrategy,
      recentStreak: streak >= 2 ? `${streak} ${streakType}` : 'none',
    };
  }

  /**
   * Actionable suggestions based on trading patterns
   */
  async getTradingSuggestions(): Promise<TradingSuggestion[]> {
    const suggestions: TradingSuggestion[] = [];
    const now = new Date();
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const trades = await this.prisma.trade.findMany({
      where: { createdAt: { gte: twoWeeksAgo }, status: 'CLOSED' },
      include: { instrument: true },
    });

    if (trades.length < 3) {
      suggestions.push({
        id: 'more-data',
        title: 'More trades needed',
        description:
          'Execute more trades so the AI can identify patterns and provide actionable suggestions.',
        priority: 'low',
        category: 'general',
      });
      return suggestions;
    }

    // Analyze by strategy
    const stratMap = new Map<
      string,
      { wins: number; losses: number; totalPnl: number }
    >();
    for (const t of trades) {
      const strat = t.strategy ?? 'unknown';
      const cur = stratMap.get(strat) ?? { wins: 0, losses: 0, totalPnl: 0 };
      if ((t.pnl ?? 0) > 0) cur.wins++;
      else cur.losses++;
      cur.totalPnl += t.pnl ?? 0;
      stratMap.set(strat, cur);
    }

    for (const [name, stats] of stratMap) {
      const total = stats.wins + stats.losses;
      const wr = total > 0 ? (stats.wins / total) * 100 : 0;

      if (total >= 5 && wr < 35) {
        suggestions.push({
          id: `weak-strat-${name}`,
          title: `Review "${name}" strategy`,
          description: `This strategy has only a ${wr.toFixed(0)}% win rate over ${total} trades with P&L of ${stats.totalPnl.toFixed(2)}. Consider adjusting parameters or pausing it.`,
          priority: 'high',
          category: 'strategy',
        });
      } else if (total >= 5 && wr > 65) {
        suggestions.push({
          id: `strong-strat-${name}`,
          title: `Increase allocation to "${name}"`,
          description: `With a ${wr.toFixed(0)}% win rate over ${total} trades, this strategy is performing well. Consider increasing position sizes cautiously.`,
          priority: 'medium',
          category: 'strategy',
        });
      }
    }

    // Check for oversized losses
    const bigLosses = trades.filter(
      (t) => (t.pnl ?? 0) < 0 && Math.abs(t.pnl ?? 0) > (t.entryPrice ?? 1) * (t.quantity ?? 1) * 0.03,
    );
    if (bigLosses.length >= 2) {
      suggestions.push({
        id: 'big-losses',
        title: 'Tighten stop losses',
        description: `You have ${bigLosses.length} trades with large losses (>3% of position). Consider tightening stop-loss levels or reducing position sizes.`,
        priority: 'high',
        category: 'risk',
      });
    }

    // Check if trades cluster at certain times
    const hourMap = new Map<number, { wins: number; total: number }>();
    for (const t of trades) {
      const hour = (t.entryTime ?? t.createdAt).getHours();
      const cur = hourMap.get(hour) ?? { wins: 0, total: 0 };
      cur.total++;
      if ((t.pnl ?? 0) > 0) cur.wins++;
      hourMap.set(hour, cur);
    }

    let worstHour: number | null = null;
    let worstHourWr = 100;
    for (const [hour, stats] of hourMap) {
      if (stats.total >= 3) {
        const wr = (stats.wins / stats.total) * 100;
        if (wr < worstHourWr) {
          worstHourWr = wr;
          worstHour = hour;
        }
      }
    }
    if (worstHour !== null && worstHourWr < 30) {
      suggestions.push({
        id: 'bad-hour',
        title: `Avoid trading around ${worstHour}:00`,
        description: `Your win rate at ${worstHour}:00 is only ${worstHourWr.toFixed(0)}%. Consider avoiding trades during this hour.`,
        priority: 'medium',
        category: 'timing',
      });
    }

    if (suggestions.length === 0) {
      suggestions.push({
        id: 'all-good',
        title: 'Looking good',
        description:
          'No significant issues detected in your recent trading patterns. Keep up the discipline.',
        priority: 'low',
        category: 'general',
      });
    }

    return suggestions;
  }

  /**
   * Build context object sent to Python AI engine
   */
  private async buildTradingContext() {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [recentTrades, settings, dailyPerf] = await Promise.all([
      this.prisma.trade.findMany({
        where: { createdAt: { gte: weekAgo } },
        include: { instrument: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.userSettings.findFirst(),
      this.prisma.dailyPerformance.findMany({
        where: { date: { gte: weekAgo } },
        orderBy: { date: 'desc' },
      }),
    ]);

    const closedTrades = recentTrades.filter((t) => t.status === 'CLOSED');
    const wins = closedTrades.filter((t) => (t.pnl ?? 0) > 0).length;
    const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const winRate =
      closedTrades.length > 0
        ? Math.round((wins / closedTrades.length) * 100)
        : 0;

    return {
      recent_trades: recentTrades.map((t) => ({
        symbol: t.instrument?.symbol ?? 'UNKNOWN',
        side: t.side,
        strategy: t.strategy ?? 'unknown',
        pnl: t.pnl ?? 0,
        status: t.status,
        entry_price: t.entryPrice ?? 0,
        exit_price: t.exitPrice ?? 0,
        entry_time: t.entryTime?.toISOString() ?? '',
        exit_time: t.exitTime?.toISOString() ?? '',
      })),
      stats: {
        total_trades: closedTrades.length,
        win_rate: winRate,
        total_pnl: Number(totalPnl.toFixed(2)),
        open_positions: recentTrades.filter((t) => t.status === 'OPEN').length,
      },
      active_strategies: settings?.activeStrategies ?? [],
      daily_performance: dailyPerf.map((dp) => ({
        date: dp.date.toISOString().split('T')[0],
        pnl: dp.totalPnl,
        trades: dp.totalTrades,
        wins: dp.winningTrades,
        losses: dp.losingTrades,
      })),
    };
  }
}
