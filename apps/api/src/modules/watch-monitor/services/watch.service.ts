import { Injectable, Logger } from '@nestjs/common';
import { Prisma, WatchEntry, WatchEventType, WatchStatus } from '@prisma/client';
import { WatchRepository } from '../repositories/watch.repository';
import { TargetCalculatorService, LevelBookSnapshot } from './target-calculator.service';
import { StrikeSelectorService } from './strike-selector.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { LevelBookService } from '../../signal-generator/services/level-book.service';
import { WatchGateway } from '../gateways/watch.gateway';

export const WATCH_CAP = 50;

export class WatchCapExceededError extends Error {
  constructor(activeCount: number) {
    super(`Watch entry cap exceeded: ${activeCount}/${WATCH_CAP} active`);
    this.name = 'WatchCapExceededError';
  }
}

export interface CreateFromAlertInput {
  alertId: string;
  setupId: string;
  symbol: string;
  token: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  initialPrice: number;
  initialScore: number;
  initialBreakdown: Prisma.InputJsonValue;
}

@Injectable()
export class WatchService {
  private readonly logger = new Logger(WatchService.name);

  constructor(
    private readonly repo: WatchRepository,
    private readonly target: TargetCalculatorService,
    private readonly strike: StrikeSelectorService,
    private readonly feed: MarketFeedService,
    private readonly levelBook: LevelBookService,
    private readonly gateway: WatchGateway,
  ) {}

  async createFromAlert(input: CreateFromAlertInput): Promise<WatchEntry> {
    const existing = await this.repo.findActiveBySetupId(input.setupId);
    if (existing) {
      this.logger.debug(`createFromAlert: returning existing entry ${existing.id} for setup ${input.setupId}`);
      return existing;
    }

    const active = await this.repo.countActive();
    if (active >= WATCH_CAP) {
      throw new WatchCapExceededError(active);
    }

    const lb = this.safeLevelBook(input.token);
    const targetResult = this.target.compute({
      side: input.side,
      entryPrice: input.initialPrice,
      levelBook: lb,
    });

    const picked = await this.safePickStrike(input);

    const entry = await this.repo.createEntry({
      alertId: input.alertId,
      setupId: input.setupId,
      symbol: input.symbol,
      token: input.token,
      exchange: input.exchange,
      side: input.side,
      initialPrice: input.initialPrice,
      initialScore: input.initialScore,
      initialBreakdown: input.initialBreakdown,
      profitTarget: targetResult.target,
      profitTargetSource: targetResult.source,
      stopLossScore: 60,
      optionsToken: picked?.optionsToken ?? null,
      optionsType: picked?.optionsType ?? null,
      optionsExpiry: picked?.optionsExpiry ?? null,
      optionsStrike: picked?.optionsStrike ?? null,
      optionsLotSize: picked?.optionsLotSize ?? null,
      optionsSelectionScore: picked?.optionsSelectionScore ?? null,
    });

    await this.repo.createEvent({
      watchEntryId: entry.id,
      eventType: WatchEventType.INITIAL,
      price: input.initialPrice,
      score: input.initialScore,
      breakdown: input.initialBreakdown,
      priceDelta: null,
      scoreDelta: null,
      notes: targetResult.source === 'fallback-10pct' ? 'pt:fallback-10pct' : null,
    });

    this.feed.subscribeForWatch(entry.token, entry.id);
    if (picked?.optionsToken) {
      this.feed.subscribeForWatch(picked.optionsToken, entry.id);
    }

    this.logger.log(
      `Watch created: ${entry.symbol} ${entry.side} score=${input.initialScore} target=${targetResult.target} (${targetResult.source})`,
    );

    return entry;
  }

  /**
   * Retrieves the level book for a token using LevelBookService.getLevels()
   * (synchronous, in-memory lookup). Returns null when the book is not yet
   * seeded. TargetCalculator falls back to 10% when null is passed.
   *
   * NOTE: The planned spec used getSnapshot() which doesn't exist on
   * LevelBookService. We use getLevels() instead (the real sync API).
   * vwapStddev is not part of the LevelBook type, so it's normalized to 0.
   */
  private safeLevelBook(token: string): LevelBookSnapshot | null {
    try {
      const snap = this.levelBook.getLevels(token);
      if (!snap) return null;
      return {
        pdh: snap.pdh,
        pdl: snap.pdl,
        orh: snap.orh ?? null,
        orl: snap.orl ?? null,
        vwap: snap.vwap,
        // LevelBook does not expose vwapStddev; normalize to 0 so
        // TargetCalculator can still compute VWAP ± σ candidates.
        vwapStddev: (snap as any).vwapStddev ?? 0,
      };
    } catch (err) {
      this.logger.warn(`safeLevelBook(${token}) failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private async safePickStrike(input: CreateFromAlertInput) {
    try {
      return await this.strike.pick({
        symbol: input.symbol.replace(/-EQ$|-BE$|-BL$|-IV$/, ''),
        side: input.side,
        underlyingPrice: input.initialPrice,
      });
    } catch (err) {
      this.logger.warn(`safePickStrike(${input.symbol}) failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // ============================================
  // State transitions
  // ============================================

  private static readonly MATERIAL_CHANGE_PCT = 0.0025;

  /**
   * Called by WatchMonitorWorker on each market tick for a watched token.
   * Drops out-of-order ticks, updates MFE/MAE watermarks, checks target
   * and material price-change thresholds, and triggers state transitions.
   */
  async onTick(token: string, ltp: number, timestamp: Date): Promise<void> {
    const entries = await this.findActiveByToken(token);
    for (const entry of entries) {
      if (entry.lastTickAt && timestamp <= entry.lastTickAt) continue;
      await this.applyTick(entry, ltp, timestamp);
    }
  }

  private async findActiveByToken(token: string) {
    return this.repo.findActiveByToken(token);
  }

  private async applyTick(entry: any, ltp: number, timestamp: Date): Promise<void> {
    const side = entry.side as 'BUY' | 'SELL';

    const maxFavorable = side === 'BUY'
      ? Math.max(entry.maxFavorable ?? entry.initialPrice, ltp)
      : Math.min(entry.maxFavorable ?? entry.initialPrice, ltp);
    const maxAdverse = side === 'BUY'
      ? Math.min(entry.maxAdverse ?? entry.initialPrice, ltp)
      : Math.max(entry.maxAdverse ?? entry.initialPrice, ltp);

    await this.repo.update(entry.id, {
      currentPrice: ltp,
      lastTickAt: timestamp,
      maxFavorable,
      maxAdverse,
    });

    this.gateway.emitTick(entry.id, { price: ltp, currentScore: entry.currentScore ?? null });

    const isTargetHit = side === 'BUY'
      ? ltp >= entry.profitTarget
      : ltp <= entry.profitTarget;
    if (isTargetHit) {
      await this.transitionTargetHit(entry.id, ltp);
      return;
    }

    const last = entry.lastEventPrice ?? entry.initialPrice;
    const delta = (ltp - last) / last;
    if (Math.abs(delta) >= WatchService.MATERIAL_CHANGE_PCT) {
      await this.repo.createEvent({
        watchEntryId: entry.id,
        eventType: WatchEventType.PRICE_CHANGE,
        price: ltp,
        priceDelta: delta * 100,
        score: null,
        breakdown: null,
      });
      await this.repo.update(entry.id, { lastEventPrice: ltp });
    }
  }

  async transitionTargetHit(entryId: string, price: number): Promise<void> {
    await this.repo.createEvent({
      watchEntryId: entryId,
      eventType: WatchEventType.TARGET_HIT,
      price,
    });
    await this.repo.update(entryId, {
      status: WatchStatus.TARGET_HIT,
      closedAt: new Date(),
      closedReason: 'target-hit',
    });
    await this.unsubscribeEntry(entryId);
  }

  async transitionStopped(
    entryId: string,
    score: number,
    cause: 'score-decay' | 'manual' | 'eod',
  ): Promise<void> {
    await this.repo.createEvent({
      watchEntryId: entryId,
      eventType: WatchEventType.SL_HIT_SCORE,
      score,
      notes: `cause:${cause}`,
    });
    await this.repo.update(entryId, {
      status: WatchStatus.STOPPED,
      closedAt: new Date(),
      closedReason: `sl-${cause}`,
    });
    await this.unsubscribeEntry(entryId);
  }

  async dismiss(entryId: string): Promise<void> {
    await this.repo.createEvent({
      watchEntryId: entryId,
      eventType: WatchEventType.DISMISSED,
    });
    await this.repo.update(entryId, {
      status: WatchStatus.DISMISSED,
      dismissedAt: new Date(),
    });
    await this.unsubscribeEntry(entryId);
  }

  private async unsubscribeEntry(entryId: string): Promise<void> {
    const entry = await this.repo.findById(entryId);
    if (!entry) return;
    this.feed.unsubscribeForWatch(entry.token, entryId);
    if (entry.optionsToken) {
      this.feed.unsubscribeForWatch(entry.optionsToken, entryId);
    }
  }
}
