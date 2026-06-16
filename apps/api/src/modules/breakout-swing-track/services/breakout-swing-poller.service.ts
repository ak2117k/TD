import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BreakoutSwingRepository } from '../repositories/breakout-swing.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import {
  NOTIONAL, TARGET_PCT, INIT_STOP_PCT, TRAIL_TRIGGER_PCT, TRAIL_GIVEBACK_PCT, BIG_MOVER_DAY_PCT,
} from '../constants';

interface TradedEntry {
  id: string;
  symbol: string;
  token: string | null;
  entryPrice: number | null;
  prevDayClose: number | null;
  stopPrice: number | null;
  trailing: boolean;
  trailingHighWater: number | null;
}

/**
 * REST-poll the breakout-swing track every 30s during market hours.
 *
 * Mirrors AdaptiveStopTickPoller: a single batched LTP call sidesteps the
 * broker's ~50-token WebSocket cap. QUEUED entries are filled when price reaches
 * the resting limit; TRADED entries are managed for target / stop / trail and
 * the big-day-mover EOD force-exit.
 */
@Injectable()
export class BreakoutSwingPollerService {
  private readonly logger = new Logger(BreakoutSwingPollerService.name);

  constructor(
    private readonly repo: BreakoutSwingRepository,
    private readonly adapter: AngelOneAdapterService,
  ) {}

  /**
   * Pure per-tick exit decision for one TRADED entry. `bigMoverWindow` is true
   * only when the cron caller is in the big-mover EOD force-exit window
   * (15:15 IST), so the day-mover check never fires mid-session.
   */
  static decideTradedTick(
    entry: { entryPrice: number; prevDayClose: number | null; stopPrice: number | null; trailing: boolean; trailingHighWater: number | null },
    ltp: number,
    bigMoverWindow: boolean,
  ):
    | { action: 'HOLD' }
    | { action: 'RATCHET_TRAIL'; highWater: number; stopPrice: number }
    | { action: 'TARGET_HIT' }
    | { action: 'STOPPED' }
    | { action: 'BIG_MOVER_EOD' } {
    const entryPx = entry.entryPrice;
    const gainPctFromEntry = ((ltp - entryPx) / entryPx) * 100;

    // 1. Target hit wins first: +TARGET_PCT from fill. Compare on the percentage
    //    (not ltp >= entryPx × 1.10) so the +10% boundary isn't lost to float.
    if (gainPctFromEntry >= TARGET_PCT) return { action: 'TARGET_HIT' };

    // 2. Big-day-mover: if the STOCK (not the trade) is up > BIG_MOVER_DAY_PCT on
    //    the day vs prev close, force-exit in the EOD window.
    if (bigMoverWindow && entry.prevDayClose != null && entry.prevDayClose > 0) {
      const dayMovePct = ((ltp - entry.prevDayClose) / entry.prevDayClose) * 100;
      if (dayMovePct > BIG_MOVER_DAY_PCT) return { action: 'BIG_MOVER_EOD' };
    }

    // 3. Trailing: once up TRAIL_TRIGGER_PCT, arm/ratchet the trailing stop. This
    //    REPLACES the −INIT_STOP_PCT hard stop. Ratchets up only.
    if (entry.trailing || gainPctFromEntry >= TRAIL_TRIGGER_PCT) {
      const highWater = Math.max(entry.trailingHighWater ?? ltp, ltp);
      const trailStop = highWater * (1 - TRAIL_GIVEBACK_PCT / 100);
      if (ltp <= trailStop) return { action: 'STOPPED' };
      // Arm on first trigger, or ratchet the high-water/stop up.
      if (!entry.trailing || highWater > (entry.trailingHighWater ?? 0)) {
        return { action: 'RATCHET_TRAIL', highWater, stopPrice: trailStop };
      }
      return { action: 'HOLD' };
    }

    // 4. Initial hard stop (only while not yet trailing).
    const stopPrice = entry.stopPrice ?? entryPx * (1 - INIT_STOP_PCT / 100);
    if (ltp <= stopPrice) return { action: 'STOPPED' };

    return { action: 'HOLD' };
  }

  // Every 30s, Mon–Fri, 09:15–15:30 IST. 6-field crontab (sec min hour … dow).
  @Cron('*/30 * 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async pollMarketHours(): Promise<void> {
    const bigMoverWindow = this.isBigMoverWindow();
    await this.fillQueued();
    await this.manageTraded(bigMoverWindow);
  }

  /** True once we are at/after BIG_MOVER_EXIT_HHMM (15:15) IST. */
  private isBigMoverWindow(): boolean {
    const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const mins = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
    return mins >= 15 * 60 + 15; // 15:15 IST
  }

  /** Fill QUEUED entries whose resting limit is reached. */
  private async fillQueued(): Promise<void> {
    const queued = await this.repo.listQueued();
    const withToken = queued.filter((e) => e.token);
    if (withToken.length === 0) return;
    const tokens = [...new Set(withToken.map((e) => e.token as string))];
    const ltpMap = await this.adapter.getLtpsBatch('NSE', tokens).catch(() => new Map<string, number>());
    const now = new Date();

    for (const entry of withToken) {
      const ltp = ltpMap.get(entry.token as string);
      if (ltp === undefined) {
        this.logger.warn(`[breakout-swing] ${entry.symbol} QUEUED — no fresh price, fill not evaluated`);
        continue;
      }
      if (ltp >= entry.limitPrice) {
        const quantity = ltp > 0 ? Math.floor(NOTIONAL / ltp) : 0;
        const stopPrice = ltp * (1 - INIT_STOP_PCT / 100);
        await this.repo.fill(entry.id, { entryPrice: ltp, enteredAt: now, quantity, stopPrice });
        this.logger.log(
          `[breakout-swing] ${entry.symbol} FILLED at ₹${ltp.toFixed(2)} (limit ₹${entry.limitPrice.toFixed(2)}), ` +
            `qty ${quantity}, stop ₹${stopPrice.toFixed(2)}`,
        );
      }
    }
  }

  /** Manage TRADED entries: target / stop / trail / big-mover, persist ticks. */
  private async manageTraded(bigMoverWindow: boolean): Promise<void> {
    const traded = (await this.repo.listTraded()) as unknown as TradedEntry[];
    const withToken = traded.filter((e) => e.token && e.entryPrice != null);
    if (withToken.length === 0) return;
    const tokens = [...new Set(withToken.map((e) => e.token as string))];
    const ltpMap = await this.adapter.getLtpsBatch('NSE', tokens).catch(() => new Map<string, number>());
    const now = new Date();

    for (const entry of withToken) {
      const ltp = ltpMap.get(entry.token as string);
      if (ltp === undefined) {
        this.logger.warn(`[breakout-swing] ${entry.symbol} TRADED — no fresh price, exits not evaluated`);
        continue;
      }
      await this.repo.recordTick(entry.id, { currentPrice: ltp, lastTickAt: now });

      const d = BreakoutSwingPollerService.decideTradedTick(
        { entryPrice: entry.entryPrice as number, prevDayClose: entry.prevDayClose, stopPrice: entry.stopPrice, trailing: entry.trailing, trailingHighWater: entry.trailingHighWater },
        ltp,
        bigMoverWindow,
      );

      if (d.action === 'TARGET_HIT') {
        await this.exit(entry, ltp, now, 'TARGET_HIT', 'target-hit');
      } else if (d.action === 'STOPPED') {
        await this.exit(entry, ltp, now, 'STOPPED', entry.trailing ? 'trailing-stop' : 'stop-hit');
      } else if (d.action === 'BIG_MOVER_EOD') {
        await this.exit(entry, ltp, now, 'BIG_MOVER_EOD', 'big-day-mover-eod');
      } else if (d.action === 'RATCHET_TRAIL') {
        await this.repo.setTrailing(entry.id, { trailingHighWater: d.highWater, stopPrice: d.stopPrice });
      }
    }
  }

  private async exit(entry: TradedEntry, ltp: number, now: Date, status: string, reason: string): Promise<void> {
    const entryPx = entry.entryPrice ?? 0;
    const qty = entryPx > 0 ? Math.floor(NOTIONAL / entryPx) : 0;
    const pnl = (ltp - entryPx) * qty;
    await this.repo.updateStatus(entry.id, { status, exitPrice: ltp, exitedAt: now, exitReason: reason });
    this.logger.log(
      `[breakout-swing] ${entry.symbol} ${status} (${reason}) at ₹${ltp.toFixed(2)} — pnl ₹${pnl.toFixed(0)}`,
    );
  }

  /** EOD: expire any QUEUED entry not filled by 15:25 IST Mon–Fri. */
  @Cron('0 25 15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async expireQueuedAtEod(): Promise<void> {
    const queued = await this.repo.listQueued();
    if (queued.length === 0) return;
    const now = new Date();
    for (const entry of queued) {
      await this.repo.updateStatus(entry.id, { status: 'EXPIRED', exitedAt: now, exitReason: 'unfilled-eod' });
    }
    this.logger.log(`[breakout-swing] expired ${queued.length} unfilled QUEUED entries at EOD`);
  }
}
