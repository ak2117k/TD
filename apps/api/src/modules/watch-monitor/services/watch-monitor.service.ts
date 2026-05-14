import { Injectable, Logger } from '@nestjs/common';
import { Prisma, WatchEntry, WatchEventType } from '@prisma/client';
import { WatchRepository } from '../repositories/watch.repository';
import { ChartinkScoringService } from '../../chartink/services/chartink-scoring.service';
import { WatchService } from './watch.service';
import { RiskGuardService } from './risk-guard.service';

@Injectable()
export class WatchMonitorService {
  private readonly logger = new Logger(WatchMonitorService.name);

  constructor(
    private readonly repo: WatchRepository,
    private readonly scoring: ChartinkScoringService,
    private readonly watch: WatchService,
    private readonly riskGuard: RiskGuardService,
  ) {}

  async tickAll(): Promise<void> {
    if (!this.isMarketHours()) return;

    // Check the daily loss breaker BEFORE running rescore — if we've already
    // hit -₹60k there's no point computing scores; just kill everything and
    // exit early. checkAndTrip returns true if breaker tripped.
    const breakerTripped = await this.riskGuard.checkAndTrip();
    if (breakerTripped) {
      this.logger.warn('Skipping rescore tick — daily loss breaker just tripped');
      return;
    }

    const entries = await this.repo.findAllActive();
    if (entries.length === 0) return;
    this.logger.debug(`rescore tick: ${entries.length} active entries`);
    const paceMs = Math.max(0, Math.floor(60_000 / Math.max(entries.length, 1)));
    for (let i = 0; i < entries.length; i++) {
      try {
        await this.rescoreOne(entries[i]);
      } catch (err) {
        this.logger.warn(
          `rescoreOne unexpected throw for ${entries[i].symbol}: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (i < entries.length - 1) await this.sleep(paceMs);
    }
  }

  async rescoreOne(entry: WatchEntry): Promise<void> {
    let result: Awaited<ReturnType<ChartinkScoringService['score']>>;
    try {
      result = await this.scoring.score({
        token: entry.token,
        symbol: entry.symbol,
        exchange: entry.exchange,
        side: entry.side as 'BUY' | 'SELL',
        entryPrice: entry.currentPrice ?? entry.initialPrice,
        setupContext: null,
      });
    } catch (err) {
      await this.repo.update(entry.id, {
        notes: `rescore-throttled: ${err instanceof Error ? err.message : err}`,
        lastRescoreAt: new Date(),
      });
      return;
    }

    const newScore = result.score;
    const priorScore = entry.currentScore ?? entry.initialScore;
    const delta = newScore - priorScore;
    const now = new Date();

    if (delta !== 0) {
      await this.repo.createEvent({
        watchEntryId: entry.id,
        eventType: WatchEventType.SCORE_CHANGE,
        score: newScore,
        scoreDelta: delta,
        breakdown: result.checks as unknown as Prisma.InputJsonValue,
      });
    }

    await this.repo.update(entry.id, {
      currentScore: newScore,
      lastRescoreAt: now,
    });

    if (newScore < entry.stopLossScore) {
      await this.watch.transitionStopped(entry.id, newScore, 'score-decay');
    }
  }

  private isMarketHours(now: Date = new Date()): boolean {
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const ist = new Date(now.getTime() + istOffsetMs);
    const day = ist.getUTCDay();
    if (day === 0 || day === 6) return false;
    const h = ist.getUTCHours();
    const m = ist.getUTCMinutes();
    const totalMin = h * 60 + m;
    return totalMin >= 9 * 60 + 15 && totalMin <= 15 * 60 + 30;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
