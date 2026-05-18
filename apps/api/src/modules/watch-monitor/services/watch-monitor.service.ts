import { Injectable, Logger } from '@nestjs/common';
import { Prisma, WatchEntry, WatchEventType } from '@prisma/client';
import { WatchRepository } from '../repositories/watch.repository';
import { ChartinkScoringService } from '../../chartink/services/chartink-scoring.service';
import { WatchService } from './watch.service';
import { RiskGuardService } from './risk-guard.service';

/**
 * Score-decay stop grace window: the score-decay stop is suppressed for the
 * first 10 minutes after an entry is created. Re-scores in this window are
 * data-thin (fresh entries lack enough fresh candles for a stable score), so
 * stopping on them false-killed ~97% of entries. The score is still written
 * normally during the window — only the stop transition is held off.
 */
const SCORE_DECAY_GRACE_MS = 10 * 60_000;

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

    // Task 5: skip data-starved re-scores entirely. A score computed from
    // insufficient fresh candles is garbage — do NOT update currentScore, do
    // NOT evaluate the score-decay stop. Leave the entry fully untouched for
    // the next tick. An entry must NEVER be stopped on a data-starved score.
    if (result.dataStarved) {
      this.logger.debug(
        `rescoreOne: skipping ${entry.symbol} (${entry.id}) — data-starved score, entry left untouched`,
      );
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
      currentBreakdown: result.checks as unknown as Prisma.InputJsonValue,
    });

    // Task 4: 10-minute grace period. The score-decay stop is suppressed for
    // the first 10 minutes after the entry was created. The score above is
    // still written normally — only the stop transition is held off. The
    // price-based target/stop path (WatchService.applyTick) is separate and
    // remains fully active throughout.
    const createdAt = entry.createdAt ?? entry.initialAt;
    const inGraceWindow =
      !!createdAt && now.getTime() - new Date(createdAt).getTime() < SCORE_DECAY_GRACE_MS;
    if (inGraceWindow) {
      if (newScore < entry.stopLossScore) {
        this.logger.debug(
          `rescoreOne: ${entry.symbol} (${entry.id}) score ${newScore} < ${entry.stopLossScore} ` +
            `but within 10-min grace window — score-decay stop suppressed`,
        );
      }
      return;
    }

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
