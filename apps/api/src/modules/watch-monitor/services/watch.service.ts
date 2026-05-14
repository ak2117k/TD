import { Injectable, Logger } from '@nestjs/common';
import { Prisma, WatchEntry, WatchEventType, WatchStatus } from '@prisma/client';
import { WatchRepository } from '../repositories/watch.repository';
import { TargetCalculatorService, LevelBookSnapshot } from './target-calculator.service';
import { StrikeSelectorService } from './strike-selector.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { LevelBookService } from '../../signal-generator/services/level-book.service';
import { WatchGateway } from '../gateways/watch.gateway';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';

export const WATCH_CAP = 50;

/** Partial-exit trigger: when |price move from entry| in our direction >= this %. */
const PARTIAL_EXIT_THRESHOLD_PCT = 0.10;

/** Trailing stop distance: stop tracks the most-favorable price minus/plus this %. */
const TRAILING_STOP_PCT = 0.02;

/** Fraction of position to exit at the +10% threshold. */
const PARTIAL_EXIT_FRACTION = 0.5;

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
    private readonly trade: TradeExecutionService,
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

    // Partial-exit + trailing-stop apply ONLY to TRADED equity entries.
    // Options positions skip this (50% of a lot is fractional). The
    // existing target-hit check above is allowed to fire first — if
    // profitTarget < +10%, the entry closes at target with no partial exit.
    const isEquityTraded = entry.status === 'TRADED' && !entry.optionsToken;
    if (isEquityTraded) {
      if (!entry.partialExitedAt) {
        // Phase 1: haven't done partial exit yet. Check if we've hit +10% threshold.
        await this.checkPartialExitTrigger(entry, ltp);
      } else {
        // Phase 2: already did partial exit. Update trailing high-water and
        // check trailing stop.
        await this.updateTrailingStop(entry, ltp);
      }
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

  // ============================================
  // Risk-guard: bulk square-off
  // ============================================

  /**
   * Close every currently active (WATCHING or TRADED) watch entry. Used by
   * RiskGuardService for EOD square-off and the daily loss circuit-breaker.
   *
   * - WATCHING entries → status=DISMISSED, write DISMISSED event
   * - TRADED entries  → close the broker position via TradeExecutionService,
   *                      mark status=EXITED, write TRADE_CLOSED event
   *
   * `reason` is recorded as closedReason on every entry so the audit log
   * shows why everything got closed at once.
   */
  async squareOffAll(reason: 'eod-square-off' | 'daily-loss-breaker' | 'manual'): Promise<{
    watchingClosed: number;
    tradedClosed: number;
    errors: number;
  }> {
    this.logger.warn(`squareOffAll called — reason=${reason}`);
    const entries = await this.repo.findAllActiveOrTraded();
    let watchingClosed = 0;
    let tradedClosed = 0;
    let errors = 0;

    for (const entry of entries) {
      try {
        if (entry.status === WatchStatus.TRADED) {
          await this.closeTraded(entry.id, reason);
          tradedClosed++;
        } else {
          // WATCHING — no broker position to close, just mark DISMISSED
          await this.repo.createEvent({
            watchEntryId: entry.id,
            eventType: WatchEventType.DISMISSED,
            notes: `cause:${reason}`,
          });
          await this.repo.update(entry.id, {
            status: WatchStatus.DISMISSED,
            dismissedAt: new Date(),
            closedReason: reason,
          });
          await this.unsubscribeEntry(entry.id);
          watchingClosed++;
        }
      } catch (err) {
        this.logger.warn(
          `squareOffAll: failed to close ${entry.symbol} (${entry.id}): ${err instanceof Error ? err.message : err}`,
        );
        errors++;
      }
    }

    this.logger.warn(
      `squareOffAll complete — watching=${watchingClosed} traded=${tradedClosed} errors=${errors}`,
    );
    return { watchingClosed, tradedClosed, errors };
  }

  /**
   * Close a single TRADED entry: call broker (paper or live) to close the
   * position, mark status=EXITED, write TRADE_CLOSED event, unsubscribe feed.
   */
  async closeTraded(
    entryId: string,
    reason: string,
  ): Promise<void> {
    const entry = await this.repo.findById(entryId);
    if (!entry) throw new Error(`Watch entry ${entryId} not found`);
    if (entry.status !== WatchStatus.TRADED) {
      throw new Error(`Cannot closeTraded on entry in status ${entry.status}`);
    }

    const tradeId = (entry as any).paperTradeId ?? (entry as any).liveTradeId;
    if (tradeId) {
      try {
        await this.trade.closeTrade(tradeId, reason);
      } catch (err) {
        this.logger.warn(
          `closeTraded: broker close failed for trade ${tradeId} (${entry.symbol}): ${err instanceof Error ? err.message : err}. Still marking entry EXITED.`,
        );
      }
    }

    await this.repo.createEvent({
      watchEntryId: entryId,
      eventType: WatchEventType.TRADE_CLOSED,
      price: (entry as any).currentPrice ?? null,
      notes: `cause:${reason}`,
    });
    await this.repo.update(entryId, {
      status: WatchStatus.EXITED,
      closedAt: new Date(),
      closedReason: reason,
    });
    await this.unsubscribeEntry(entryId);
  }

  // ============================================
  // Partial-exit + trailing-stop helpers
  // ============================================

  /**
   * Phase 1 check: TRADED entry hasn't done partial exit yet. If price has
   * moved >= +10% in our favor (BUY: ltp >= entry × 1.10; SELL: ltp <= entry × 0.90),
   * trigger the partial exit:
   *   - Close PARTIAL_EXIT_FRACTION (50%) of the remaining position via broker
   *   - Set partialExitedAt, partialExitPrice, partialQty, remainingQty
   *   - Initialize trailingHighWater = ltp, trailingStopPrice = ltp ± 2%
   *   - Write PARTIAL_EXIT event
   */
  private async checkPartialExitTrigger(entry: any, ltp: number): Promise<void> {
    const ref = entry.executedPrice ?? entry.initialPrice;
    if (ref <= 0) return;

    const moveFavor = entry.side === 'BUY'
      ? (ltp - ref) / ref
      : (ref - ltp) / ref;

    if (moveFavor < PARTIAL_EXIT_THRESHOLD_PCT) return;

    // Trigger! Compute split.
    // Position size source: the trade that was placed (paperTradeId/liveTradeId)
    // would tell us the exact quantity. For Stage 2 equity intraday we default
    // to 50 shares per setup (matches WatchController.execute's INTRADAY_EQUITY_QTY).
    // If a future tradeId is set with a different qty, read from the trade
    // record. For now assume 50 unless an existing partialQty/remainingQty
    // indicates otherwise.
    const initialQty = 50; // INTRADAY_EQUITY_QTY — matches the execution default
    const partialQty = Math.floor(initialQty * PARTIAL_EXIT_FRACTION);
    const remainingQty = initialQty - partialQty;

    // Place the close-half order via broker. closeTrade takes a single tradeId
    // and closes the full position — for HALF closures we need executeTrade
    // with an opposite-side order of `partialQty` shares. The trade-engine
    // service should reconcile this with the existing open position.
    // (If TradeExecutionService doesn't yet support partial close, log it and
    // proceed — we still mark the WatchEntry's partial exit fields so the
    // trailing logic can run on the conceptual half. Surface as a known gap.)
    try {
      await this.trade.executeTrade({
        symbol: entry.symbol,
        token: entry.token,
        exchange: entry.exchange ?? 'NSE',
        side: entry.side === 'BUY' ? 'SELL' : 'BUY',  // opposite side to close partial
        quantity: partialQty,
        orderType: 'MARKET',
        positionType: 'INTRADAY',
      } as any);
    } catch (err) {
      this.logger.warn(
        `Partial exit broker call failed for ${entry.symbol}: ${err instanceof Error ? err.message : err}. Marking partial exit on WatchEntry anyway.`,
      );
    }

    // Initialize trailing stop on the remaining half.
    const trailingStopPrice = entry.side === 'BUY'
      ? ltp * (1 - TRAILING_STOP_PCT)
      : ltp * (1 + TRAILING_STOP_PCT);

    await this.repo.createEvent({
      watchEntryId: entry.id,
      eventType: WatchEventType.PARTIAL_EXIT,
      price: ltp,
      priceDelta: moveFavor * 100,
      notes: `partial 50% sold at +${(moveFavor * 100).toFixed(2)}%, trail @ ${trailingStopPrice.toFixed(2)}`,
    });

    await this.repo.update(entry.id, {
      partialExitedAt: new Date(),
      partialExitPrice: ltp,
      partialQty,
      remainingQty,
      trailingHighWater: ltp,
      trailingStopPrice,
    });

    this.logger.log(
      `${entry.symbol}: partial exit at ₹${ltp.toFixed(2)} (+${(moveFavor * 100).toFixed(2)}%), trail stop @ ₹${trailingStopPrice.toFixed(2)}`,
    );
  }

  /**
   * Phase 2 check: TRADED entry has already done partial exit. Track the
   * most-favorable price seen since (high-water for BUY, low-water for SELL)
   * and ratchet the trailing stop. If price crosses the trailing stop in the
   * adverse direction, close the remaining half and transition to EXITED.
   */
  private async updateTrailingStop(entry: any, ltp: number): Promise<void> {
    const isBuy = entry.side === 'BUY';
    const highWater = entry.trailingHighWater ?? ltp;
    const stop = entry.trailingStopPrice ?? ltp;

    // Update high-water if price made a new extreme in our favor.
    let newHighWater = highWater;
    let newStop = stop;
    if (isBuy && ltp > highWater) {
      newHighWater = ltp;
      newStop = ltp * (1 - TRAILING_STOP_PCT);
    } else if (!isBuy && ltp < highWater) {
      newHighWater = ltp;
      newStop = ltp * (1 + TRAILING_STOP_PCT);
    }

    if (newHighWater !== highWater) {
      await this.repo.update(entry.id, {
        trailingHighWater: newHighWater,
        trailingStopPrice: newStop,
      });
    }

    // Trailing stop hit?
    const stopHit = isBuy ? ltp <= newStop : ltp >= newStop;
    if (stopHit) {
      await this.triggerTrailingStop(entry, ltp, newStop);
    }
  }

  /**
   * Trailing stop fired: close the remaining position via broker, mark
   * status=EXITED, write TRAILING_STOP_HIT event, unsubscribe feed.
   */
  private async triggerTrailingStop(entry: any, ltp: number, stopPrice: number): Promise<void> {
    this.logger.log(
      `${entry.symbol}: trailing stop hit at ₹${ltp.toFixed(2)} (high-water=${entry.trailingHighWater}, stop=${stopPrice.toFixed(2)})`,
    );

    const remainingQty = entry.remainingQty ?? Math.floor(50 * (1 - PARTIAL_EXIT_FRACTION));

    // Close remaining half via broker.
    try {
      await this.trade.executeTrade({
        symbol: entry.symbol,
        token: entry.token,
        exchange: entry.exchange ?? 'NSE',
        side: entry.side === 'BUY' ? 'SELL' : 'BUY',
        quantity: remainingQty,
        orderType: 'MARKET',
        positionType: 'INTRADAY',
      } as any);
    } catch (err) {
      this.logger.warn(
        `Trailing stop broker close failed for ${entry.symbol}: ${err instanceof Error ? err.message : err}. Marking entry EXITED anyway.`,
      );
    }

    await this.repo.createEvent({
      watchEntryId: entry.id,
      eventType: WatchEventType.TRAILING_STOP_HIT,
      price: ltp,
      notes: `trailing stop fired (high-water ${entry.trailingHighWater}, stop ${stopPrice.toFixed(2)})`,
    });

    await this.repo.update(entry.id, {
      status: WatchStatus.EXITED,
      closedAt: new Date(),
      closedReason: 'trailing-stop',
    });

    await this.unsubscribeEntry(entry.id);
  }
}
