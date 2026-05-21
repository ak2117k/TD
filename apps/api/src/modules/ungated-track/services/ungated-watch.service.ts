import { Injectable, Logger } from '@nestjs/common';
import { Prisma, WatchEventType, WatchStatus } from '@prisma/client';
import {
  UngatedWatchRepository, UngatedCreateEntryInput,
} from '../repositories/ungated-watch.repository';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import { UngatedPaperAccountService, TRADE_CAPITAL } from './ungated-paper-account.service';
import { UngatedTradeExecutionService } from './ungated-trade-execution.service';
import { UngatedWatchGateway } from '../gateways/ungated-watch.gateway';
// Note: NO MarketFeedService dependency — the ungated track uses
// `UngatedTickPoller` (REST every 30s) to sidestep the broker's
// ~50-token WebSocket cap. See specs/2026-05-20-ungated-shadow-track-design.md.

export class UngatedSymbolDupError extends Error {
  constructor(public readonly symbol: string) {
    super(`ungated: symbol ${symbol} already has an active entry`);
    this.name = 'UngatedSymbolDupError';
  }
}
export class UngatedCooldownError extends Error {
  constructor(public readonly symbol: string) {
    super(`ungated: symbol ${symbol} in cooldown`);
    this.name = 'UngatedCooldownError';
  }
}

export interface UngatedCreateFromAlertInput {
  alertId: string | null;
  setupId: string | null;
  symbol: string;
  token: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  initialPrice: number;
  initialScore: number;
  initialBreakdown: Prisma.InputJsonValue;
}

const PROFIT_TARGET_PCT = 0.02; // 2% fallback — no indicator-sr on ungated (YAGNI)
export const TRADE_COOLDOWN_MS = 30 * 60_000;

@Injectable()
export class UngatedWatchService {
  private readonly logger = new Logger(UngatedWatchService.name);

  constructor(
    private readonly repo: UngatedWatchRepository,
    private readonly trades: UngatedTradeRepository,
    private readonly account: UngatedPaperAccountService,
    private readonly exec: UngatedTradeExecutionService,
    private readonly gateway: UngatedWatchGateway,
  ) {}

  async createFromAlert(input: UngatedCreateFromAlertInput) {
    // 1. Symbol dedup — token-based, mirrors gated rule.
    const active = await this.repo.findActiveByToken(input.token);
    if (active.length > 0) throw new UngatedSymbolDupError(input.symbol);

    // 2. Admission (capital + position cap + kill switch).
    const openTrades = await this.repo.countOpenTrades();
    await this.account.admit({ openTrades });

    // 3. Compute the 2% fallback profit target.
    const sideMul = input.side === 'BUY' ? 1 : -1;
    const profitTarget =
      input.initialPrice * (1 + sideMul * PROFIT_TARGET_PCT);

    // 4. Create the WATCHING entry row.
    const createInput: UngatedCreateEntryInput = {
      alertId: input.alertId,
      setupId: input.setupId,
      symbol: input.symbol,
      token: input.token,
      exchange: input.exchange,
      side: input.side,
      initialPrice: input.initialPrice,
      initialScore: input.initialScore,
      initialBreakdown: input.initialBreakdown,
      profitTarget,
      profitTargetSource: 'fallback-2pct',
      stopLossScore: 50,
    };
    const entry = await this.repo.createEntry(createInput);
    await this.repo.createEvent({
      watchEntryId: entry.id,
      eventType: WatchEventType.INITIAL,
      price: input.initialPrice,
      score: input.initialScore,
      breakdown: input.initialBreakdown,
    });

    // 5. Auto-execute.
    const qty = Math.max(1, Math.floor(TRADE_CAPITAL / Math.max(input.initialPrice, 1)));
    const trade = await this.exec.openTrade({
      instrumentId: entry.id,
      side: input.side,
      quantity: qty,
      entryPrice: input.initialPrice,
      exchange: input.exchange,
      target: profitTarget,
    });
    await this.repo.update(entry.id, {
      status: WatchStatus.TRADED,
      paperTradeId: trade.id,
      executedAt: new Date(),
      executedPrice: input.initialPrice,
      quantity: qty,
    });

    // No feed.subscribeForWatch here: ungated entries are driven by the
    // REST poller (UngatedTickPoller) on a 30-second cron, not WS.

    return entry;
  }

  // --- Constants ---
  private readonly HARD_STOP_PCT = 0.004;
  private readonly PARTIAL_EXIT_THRESHOLD_PCT = 0.01;
  private readonly PARTIAL_EXIT_FRACTION = 0.5;
  private readonly TRAILING_STOP_PCT = 0.005;

  // --- Public tick entrypoint ---
  async onTick(token: string, ltp: number, ts: Date): Promise<void> {
    const entries = await this.repo.findActiveByToken(token);
    for (const entry of entries) {
      if (entry.status !== 'TRADED') continue;
      // Persist the live price so the frontend's P&L column has a value
      // to render. Mirrors what gated WatchService writes on every tick.
      try {
        await this.repo.update(entry.id, { currentPrice: ltp, lastTickAt: ts });
        // Push the full updated row via WebSocket so the frontend merges
        // in place — no per-tick refetch, no table flash.
        const fresh = await this.repo.findById(entry.id);
        if (fresh) this.gateway.emitEntry(fresh);
      } catch (err) {
        this.logger.warn(`[ungated] failed to persist tick for ${entry.symbol}: ${err}`);
      }
      try {
        await this.applyTick(entry, ltp);
      } catch (err) {
        this.logger.warn(
          `[ungated] applyTick ${entry.symbol} threw: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  private async applyTick(entry: any, ltp: number): Promise<void> {
    const sideMul: 1 | -1 = entry.side === 'BUY' ? 1 : -1;

    // 1. Target-hit wins first.
    const isTargetHit =
      entry.profitTarget != null &&
      (sideMul === 1 ? ltp >= entry.profitTarget : ltp <= entry.profitTarget);
    if (isTargetHit) return this.transitionTargetHit(entry, ltp);

    // 2. Hard loss-cut (R5).
    const openLoss = this.computeOpenPnl(entry, ltp);
    const threshold = -this.HARD_STOP_PCT *
      (entry.executedPrice ?? entry.initialPrice) *
      (entry.remainingQty ?? entry.quantity ?? 0);
    if (openLoss <= threshold) return this.transitionLossCut(entry, ltp, openLoss);

    // 3. Partial-exit / trailing-stop.
    if (!entry.partialExitedAt) {
      await this.checkPartialExitTrigger(entry, ltp);
    } else {
      await this.updateTrailingStop(entry, ltp);
    }
  }

  private computeOpenPnl(entry: any, ltp: number): number {
    const ref = entry.executedPrice ?? entry.initialPrice;
    const sideMul: 1 | -1 = entry.side === 'BUY' ? 1 : -1;
    const qty = entry.remainingQty ?? entry.quantity ?? 0;
    return (ltp - ref) * sideMul * qty;
  }

  private async transitionTargetHit(entry: any, price: number): Promise<void> {
    await this.repo.createEvent({
      watchEntryId: entry.id, eventType: WatchEventType.TARGET_HIT, price,
    });
    await this.exec.closeTrade(entry.paperTradeId, {
      reason: 'target-hit', exitPrice: price,
    });
    await this.repo.update(entry.id, {
      status: WatchStatus.TARGET_HIT, closedAt: new Date(), closedReason: 'target-hit',
    });
  }

  private async transitionLossCut(entry: any, exitPrice: number, openLoss: number): Promise<void> {
    await this.repo.createEvent({
      watchEntryId: entry.id, eventType: WatchEventType.SL_HIT_PRICE, price: exitPrice,
      notes: `cause:loss-cut loss:${Math.abs(openLoss).toFixed(0)}`,
    });
    await this.exec.closeTrade(entry.paperTradeId, {
      reason: 'sl-loss-cut', exitPrice,
    });
    await this.repo.update(entry.id, {
      status: WatchStatus.STOPPED, closedAt: new Date(), closedReason: 'loss-cut',
    });
  }

  private async checkPartialExitTrigger(entry: any, ltp: number): Promise<void> {
    const ref = entry.executedPrice ?? entry.initialPrice;
    if (ref <= 0) return;
    const sideMul: 1 | -1 = entry.side === 'BUY' ? 1 : -1;
    const moveFavor = ((ltp - ref) / ref) * sideMul;
    if (moveFavor < this.PARTIAL_EXIT_THRESHOLD_PCT) return;

    const initialQty = entry.quantity ??
      Math.max(1, Math.floor(2_00_000 / Math.max(ref, 1)));
    const partialQty = Math.floor(initialQty * this.PARTIAL_EXIT_FRACTION);
    const remainingQty = initialQty - partialQty;
    const trailingStopPrice = sideMul === 1
      ? ltp * (1 - this.TRAILING_STOP_PCT)
      : ltp * (1 + this.TRAILING_STOP_PCT);

    await this.exec.closeTrade(entry.paperTradeId, {
      reason: 'partial-exit', quantity: partialQty, exitPrice: ltp,
    });
    await this.repo.createEvent({
      watchEntryId: entry.id, eventType: WatchEventType.PARTIAL_EXIT, price: ltp,
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
  }

  private async updateTrailingStop(entry: any, ltp: number): Promise<void> {
    const sideMul: 1 | -1 = entry.side === 'BUY' ? 1 : -1;
    let highWater = entry.trailingHighWater;
    let newStop = entry.trailingStopPrice;
    const moves = sideMul === 1 ? ltp > highWater : ltp < highWater;
    if (moves) {
      highWater = ltp;
      newStop = sideMul === 1 ? ltp * (1 - this.TRAILING_STOP_PCT) : ltp * (1 + this.TRAILING_STOP_PCT);
      await this.repo.update(entry.id, {
        trailingHighWater: highWater,
        trailingStopPrice: newStop,
      });
    }
    const hit = sideMul === 1 ? ltp <= newStop : ltp >= newStop;
    if (hit) {
      await this.exec.closeTrade(entry.paperTradeId, {
        reason: 'trailing-stop', exitPrice: ltp,
      });
      await this.repo.createEvent({
        watchEntryId: entry.id, eventType: WatchEventType.TRAILING_STOP_HIT, price: ltp,
        notes: `trail stop fired (high-water ${highWater}, stop ${newStop.toFixed(2)})`,
      });
      await this.repo.update(entry.id, {
        status: WatchStatus.EXITED, closedAt: new Date(), closedReason: 'trailing-stop',
      });
    }
  }
}
