import { Injectable, Logger } from '@nestjs/common';
import { Prisma, WatchEntry, WatchEventType, WatchStatus } from '@prisma/client';
import { WatchRepository } from '../repositories/watch.repository';
import { TargetCalculatorService, LevelBookSnapshot } from './target-calculator.service';
import { StrikeSelectorService } from './strike-selector.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { LevelBookService } from '../../signal-generator/services/level-book.service';
import { WatchGateway } from '../gateways/watch.gateway';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';
import { DEFAULT_MAX_CAPITAL_PER_TRADE } from '@td/shared';

export const WATCH_CAP = 50;

/** Partial-exit trigger: when |price move from entry| in our direction >= this %.
 *  Revised from 0.10 → 0.01 for realistic intraday scalping. */
const PARTIAL_EXIT_THRESHOLD_PCT = 0.01;

/** Trailing stop distance: stop tracks the most-favorable price minus/plus this %.
 *  Revised from 0.02 → 0.005 — tighter trail prevents giving back the 1% gain. */
const TRAILING_STOP_PCT = 0.005;

/** Fraction of position to exit at the partial-exit threshold. (Unchanged.) */
const PARTIAL_EXIT_FRACTION = 0.5;

/** Maximum ₹ deployed per trade. Determines share quantity:
 *  qty = floor(MAX_INVESTMENT_PER_TRADE / referencePrice).
 *  Sourced from the shared per-trade risk cap (DEFAULT_MAX_CAPITAL_PER_TRADE)
 *  so the watch sizer can never build an order the RiskManager will reject. */
export const MAX_INVESTMENT_PER_TRADE = DEFAULT_MAX_CAPITAL_PER_TRADE;

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

  /**
   * List watch entries (optionally a single IST day) enriched with the
   * triggering Chartink scanner name and, for closed entries, the linked
   * trade's realized P/L.
   */
  async list(opts: { status?: WatchStatus; date?: string }): Promise<
    Array<WatchEntry & { scannerName: string | null; realizedPnl: number | null }>
  > {
    const entries = await this.repo.list(opts);
    const alertIds = entries
      .map((e) => e.alertId)
      .filter((x): x is string => !!x);
    const tradeIds = entries
      .map((e) => e.paperTradeId ?? e.liveTradeId)
      .filter((x): x is string => !!x);
    const [scannerNames, realizedPnls] = await Promise.all([
      this.repo.findScannerNames(alertIds),
      this.repo.findRealizedPnls(tradeIds),
    ]);
    return entries.map((e) => {
      const tradeId = e.paperTradeId ?? e.liveTradeId;
      return {
        ...e,
        scannerName: e.alertId ? scannerNames.get(e.alertId) ?? null : null,
        realizedPnl: tradeId ? realizedPnls.get(tradeId) ?? null : null,
      };
    });
  }

  async createFromAlert(input: CreateFromAlertInput): Promise<WatchEntry> {
    // Tier 1 dedup: same Chartink setup (retries / Bull job replays).
    const existingBySetup = await this.repo.findActiveBySetupId(input.setupId);
    if (existingBySetup) {
      this.logger.debug(
        `createFromAlert: returning existing entry ${existingBySetup.id} for setup ${input.setupId}`,
      );
      return existingBySetup;
    }

    // Tier 2 dedup: same STOCK already has an active watch entry. Without
    // this, a stock that fires across multiple Chartink scanners in the same
    // session creates duplicate WatchEntry rows — wasteful, confusing on the
    // /watch UI, and inflates the 50-slot cap counter. We keep the FIRST
    // entry and reuse it; subsequent fires return the existing one.
    const existingByToken = await this.repo.findActiveByToken(input.token);
    if (existingByToken.length > 0) {
      const reused = existingByToken[0];
      this.logger.log(
        `createFromAlert: ${input.symbol} already being watched (entry ${reused.id}, status=${reused.status}) — skipping duplicate from setup ${input.setupId}`,
      );
      return reused;
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
      // Score-decay stop fires when a re-score drops below this floor. Kept
      // BELOW the 60 entry-admission floor so an entry admitted at 60-69 is
      // not dead-on-arrival — the stop only fires on genuine decay under 50.
      stopLossScore: 50,
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
      notes: targetResult.source === 'fallback-2pct' ? 'pt:fallback-2pct' : null,
    });

    this.feed.subscribeForWatch(entry.token, entry.id);
    if (picked?.optionsToken) {
      this.feed.subscribeForWatch(picked.optionsToken, entry.id);
    }

    this.logger.log(
      `Watch created: ${entry.symbol} ${entry.side} score=${input.initialScore} target=${targetResult.target} (${targetResult.source})`,
    );

    // Auto-execute: criteria is already met (score≥50, sector gate passed,
    // MTF aligned, dedup OK), so place the paper trade immediately and let
    // the watch-monitor manage the lifecycle (partial exit, trailing stop,
    // score-decay SL, EOD square-off).
    //
    // Failures (insufficient cash, market closed, daily loss breaker) are
    // caught and logged — the entry remains WATCHING so the user can retry
    // manually from the UI. We never roll back the WatchEntry, since the
    // scoring decision and dedup state are valuable journal data even when
    // the broker call fails.
    try {
      const traded = await this.executeEntry(entry.id, { mode: 'paper' });
      this.logger.log(
        `Auto-executed paper trade for ${entry.symbol} @ ₹${(traded as any).entryPrice ?? input.initialPrice}`,
      );
      // Re-fetch so the caller sees TRADED status (not the stale WATCHING).
      const updated = await this.repo.findById(entry.id);
      return updated ?? entry;
    } catch (err) {
      this.logger.warn(
        `Auto-execute failed for ${entry.symbol} (entry stays WATCHING for manual retry): ${err instanceof Error ? err.message : err}`,
      );
      return entry;
    }
  }

  /**
   * Place the broker order for a WATCHING entry and transition it to TRADED.
   * Called both manually (POST /api/watch/:id/execute) and automatically
   * (right after createFromAlert succeeds in paper mode). All RiskManager
   * checks run inside trade.executeTrade — insufficient cash, daily-loss
   * breaker, market-hours gate, duplicate-position guard, kill switch.
   *
   * Quantity selection:
   *   - F&O leg present → lotCount × optionsLotSize
   *   - Equity intraday → floor(MAX_INVESTMENT_PER_TRADE / referencePrice)
   * Caller can override with `quantityOverride`. Reference price prefers
   * the live currentPrice over the initial fire price so we size against
   * what we'll actually pay.
   */
  async executeEntry(
    entryId: string,
    options: { mode?: 'paper' | 'live'; quantityOverride?: number } = {},
  ): Promise<any> {
    const mode = options.mode ?? 'paper';
    const entry = await this.repo.findById(entryId);
    if (!entry) throw new Error(`WatchEntry ${entryId} not found`);
    if (entry.status !== WatchStatus.WATCHING) {
      throw new Error(`Cannot execute on entry in status ${entry.status}`);
    }

    const optionsLotSize = (entry as any).optionsLotSize ?? null;
    const lotCount = (entry.initialBreakdown as any)?.lotCount ?? 1;
    const referencePrice = (entry as any).currentPrice ?? entry.initialPrice;
    const computedQty = optionsLotSize
      ? lotCount * optionsLotSize
      : Math.max(1, Math.floor(MAX_INVESTMENT_PER_TRADE / Math.max(referencePrice, 1)));
    const qty = options.quantityOverride ?? computedQty;

    const trade = await this.trade.executeTrade({
      symbol: (entry as any).optionsToken ? (entry as any).optionsToken : entry.symbol,
      // Equity fallback must be the numeric instrument token (entry.token),
      // not the symbol — findInstrumentId resolves NSE cash by token.
      token: (entry as any).optionsToken ?? entry.token,
      exchange: (entry as any).exchange ?? 'NSE',
      side: entry.side as any,
      quantity: qty,
      orderType: 'MARKET' as any,
      positionType: 'INTRADAY' as any,
      // Pass referencePrice so the RiskManager's paper-cash check can
      // estimate orderValue on MARKET orders (which otherwise have no
      // price field).
      price: referencePrice,
      stoploss: (entry as any).stopLoss ?? undefined,
      target: (entry as any).profitTarget ?? undefined,
    } as any);

    await this.repo.update(entryId, {
      status: WatchStatus.TRADED,
      executedAt: new Date(),
      executedPrice:
        (trade as any).entryPrice ??
        (entry as any).currentPrice ??
        (entry as any).initialPrice,
      paperTradeId: mode === 'paper' ? (trade as any).id : null,
      liveTradeId: mode === 'live' ? (trade as any).id : null,
    });

    return trade;
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
    const entry = await this.repo.findById(entryId);
    await this.repo.createEvent({
      watchEntryId: entryId,
      eventType: WatchEventType.TARGET_HIT,
      price,
    });
    // Close the linked trade so deployed capital is returned to cash.
    await this.closeLinkedTrade(entry, 'target-hit');
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
    const entry = await this.repo.findById(entryId);
    await this.repo.createEvent({
      watchEntryId: entryId,
      eventType: WatchEventType.SL_HIT_SCORE,
      score,
      notes: `cause:${cause}`,
    });
    // Close the linked trade so deployed capital is returned to cash.
    await this.closeLinkedTrade(entry, `sl-${cause}`);
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

  /**
   * Close the broker/paper trade linked to a watch entry so the cash
   * balance is returned and the Trade record is marked CLOSED. Tolerant:
   * a broker failure is logged, never thrown — the entry status transition
   * must still proceed so the watch lifecycle is never left half-done.
   */
  private async closeLinkedTrade(entry: any, reason: string): Promise<void> {
    const tradeId = entry?.paperTradeId ?? entry?.liveTradeId;
    if (!tradeId) return;
    try {
      await this.trade.closeTrade(tradeId, reason);
    } catch (err) {
      this.logger.warn(
        `closeLinkedTrade: failed to close trade ${tradeId} for ${entry?.symbol}: ` +
          `${err instanceof Error ? err.message : err}. Entry status still updated.`,
      );
    }
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

    await this.closeLinkedTrade(entry, reason);

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
   * moved >= +1% in our favor (BUY: ltp >= entry × 1.01; SELL: ltp <= entry × 0.99),
   * trigger the partial exit:
   *   - Close PARTIAL_EXIT_FRACTION (50%) of the remaining position via broker
   *   - Set partialExitedAt, partialExitPrice, partialQty, remainingQty
   *   - Initialize trailingHighWater = ltp, trailingStopPrice = ltp ± 0.5%
   *   - Write PARTIAL_EXIT event
   */
  private async checkPartialExitTrigger(entry: any, ltp: number): Promise<void> {
    const ref = entry.executedPrice ?? entry.initialPrice;
    if (ref <= 0) return;

    const moveFavor = entry.side === 'BUY'
      ? (ltp - ref) / ref
      : (ref - ltp) / ref;

    if (moveFavor < PARTIAL_EXIT_THRESHOLD_PCT) return;

    // Trigger! Compute the split quantities for the WatchEntry bookkeeping.
    const initialQty = Math.max(1, Math.floor(MAX_INVESTMENT_PER_TRADE / Math.max(ref, 1)));
    const partialQty = Math.floor(initialQty * PARTIAL_EXIT_FRACTION);
    const remainingQty = initialQty - partialQty;

    // Partially close the linked trade: closeTrade shrinks the original
    // Trade row to PARTIALLY_FILLED and credits cash for the closed slice —
    // no orphan rows, so the trades table stays a clean source of truth.
    const partialTradeId = entry.paperTradeId ?? entry.liveTradeId;
    if (partialTradeId) {
      try {
        await this.trade.closeTrade(partialTradeId, {
          reason: 'partial-exit',
          quantity: partialQty,
        });
      } catch (err) {
        this.logger.warn(
          `Partial exit close failed for ${entry.symbol}: ${err instanceof Error ? err.message : err}. Marking partial exit on WatchEntry anyway.`,
        );
      }
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

    // Close the remaining position via the linked trade — closeTrade
    // credits cash and marks the Trade record CLOSED (whatever quantity
    // remains after the earlier partial exit).
    await this.closeLinkedTrade(entry, 'trailing-stop');

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
