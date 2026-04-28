import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { SetupContext } from '../types/setup-context.types';

export interface RecommendedStrike {
  strike: number;
  side: 'CE' | 'PE';
  expiry: string;
  ltp: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  oi: number;
  volume: number;
  /** Expected premium gain per share if spot reaches target (delta + half-gamma estimate). */
  expectedProfitPerShare: number;
  /** Expected premium loss per share if spot hits stop. */
  expectedLossPerShare: number;
  lotSize: number;
  expectedProfitPerLot: number;
  expectedLossPerLot: number;
  reason: string;
}

export type SetupStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'PARTIAL_BOOKED'
  | 'TARGET_HIT'
  | 'STOPPED'
  | 'TRAIL_STOPPED'
  | 'EOD'
  | 'INVALIDATED';

export interface LockedSetup {
  id: string;
  token: string;
  symbol: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  setupType: 'BREAKOUT' | 'REVERSAL';
  levelType: SetupContext['levelType'];
  levelValue: number;
  entry: number;
  stoploss: number;
  target: number;
  /** 1×SL distance in profit. When spot reaches this, 50% is booked and SL ratchets to break-even. */
  partialTakeAt: number;
  /** Null until PARTIAL_BOOKED, then ratchets toward profit. */
  trailingSl: number | null;
  grade: 'A' | 'B' | 'C';
  atr14: number;
  status: SetupStatus;
  createdAt: Date;
  triggeredAt: Date | null;
  partialBookedAt: Date | null;
  runnerExitAt: Date | null;
  closedAt: Date | null;
  closeReason: SetupStatus | null;
  high: number;
  low: number;
  indicators: SetupContext['indicators'];
  higherTimeframeTrend: SetupContext['higherTimeframeTrend'];
  regime: SetupContext['regime'];
  intradayRangeRatio: number;
  reason: string;
  /**
   * Strike recommendation locked in at setup-detection time. Frozen across
   * subsequent polls so the panel doesn't churn as option LTP drifts.
   */
  recommendedStrike: RecommendedStrike | null;
}

export interface LockInput {
  token: string;
  symbol: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  setupType: 'BREAKOUT' | 'REVERSAL';
  levelType: SetupContext['levelType'];
  levelValue: number;
  entry: number;
  stoploss: number;
  target: number;
  partialTakeAt: number;
  grade: 'A' | 'B' | 'C';
  atr14: number;
  indicators: SetupContext['indicators'];
  higherTimeframeTrend: SetupContext['higherTimeframeTrend'];
  regime: SetupContext['regime'];
  intradayRangeRatio: number;
  reason: string;
  recommendedStrike?: RecommendedStrike | null;
}

const EOD_AGE_MS = 8 * 60 * 60 * 1000;
const HISTORY_CAP_PER_TOKEN = 20;

const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MINUTE = 0;
const NSE_CLOSE_HOUR = 15;
const NSE_CLOSE_MINUTE = 30;
const MCX_CLOSE_HOUR = 23;
const MCX_CLOSE_MINUTE = 30;

@Injectable()
export class SetupTrackerService {
  private readonly logger = new Logger(SetupTrackerService.name);
  private readonly active = new Map<string, LockedSetup>();
  private readonly history = new Map<string, LockedSetup[]>();

  constructor(private readonly marketFeed: MarketFeedService) {}

  getActive(token: string): LockedSetup | null {
    return this.active.get(token) ?? null;
  }

  getHistory(token: string): LockedSetup[] {
    return this.history.get(token) ?? [];
  }

  lock(input: LockInput): LockedSetup | null {
    const existing = this.active.get(input.token);
    if (existing && this.isOpen(existing.status)) {
      return null;
    }
    const now = new Date();
    const setup: LockedSetup = {
      id: randomUUID(),
      token: input.token,
      symbol: input.symbol,
      exchange: input.exchange,
      side: input.side,
      setupType: input.setupType,
      levelType: input.levelType,
      levelValue: input.levelValue,
      entry: input.entry,
      stoploss: input.stoploss,
      target: input.target,
      partialTakeAt: input.partialTakeAt,
      trailingSl: null,
      grade: input.grade,
      atr14: input.atr14,
      status: 'PENDING',
      createdAt: now,
      triggeredAt: null,
      partialBookedAt: null,
      runnerExitAt: null,
      closedAt: null,
      closeReason: null,
      high: input.entry,
      low: input.entry,
      indicators: input.indicators,
      higherTimeframeTrend: input.higherTimeframeTrend,
      regime: input.regime,
      intradayRangeRatio: input.intradayRangeRatio,
      reason: input.reason,
      recommendedStrike: input.recommendedStrike ?? null,
    };
    this.active.set(input.token, setup);
    this.logger.log(
      `Locked ${input.side} ${input.setupType} ${input.symbol} entry=${input.entry.toFixed(2)} sl=${input.stoploss.toFixed(2)} tgt=${input.target.toFixed(2)} grade=${input.grade}`,
    );
    return setup;
  }

  updateFromTick(token: string, spot: number, now: Date): LockedSetup | null {
    const setup = this.active.get(token);
    if (!setup) return null;
    if (!this.isOpen(setup.status)) return setup;

    if (spot > setup.high) setup.high = spot;
    if (spot < setup.low) setup.low = spot;

    // Age-based EOD check first — closes setups that have run past
    // their daily horizon regardless of spot.
    if (now.getTime() - setup.createdAt.getTime() >= EOD_AGE_MS) {
      this.close(setup, 'EOD', now);
      return setup;
    }
    if (this.sessionEnded(setup.exchange, now)) {
      this.close(setup, 'EOD', now);
      return setup;
    }

    if (setup.status === 'PENDING') {
      const triggered =
        setup.side === 'BUY' ? spot >= setup.entry : spot <= setup.entry;
      if (triggered) {
        setup.status = 'ACTIVE';
        setup.triggeredAt = now;
        this.logger.log(
          `Setup ${setup.id} (${setup.symbol}) triggered at ${spot.toFixed(2)} → ACTIVE`,
        );
      }
      return setup;
    }

    // Order matters: TARGET wins over the partial-take check on the same
    // tick (best-case outcome — full target reached before booking 50%),
    // and PARTIAL_BOOKED happens before SL because once we're at 1×SL
    // profit the stop ratchets to break-even and the original SL is moot.
    if (setup.status === 'ACTIVE') {
      if (setup.side === 'BUY') {
        if (spot >= setup.target) {
          this.close(setup, 'TARGET_HIT', now);
          return setup;
        }
        if (spot >= setup.partialTakeAt) {
          this.bookPartial(setup, now);
          return setup;
        }
        if (spot <= setup.stoploss) {
          this.close(setup, 'STOPPED', now);
        }
      } else {
        if (spot <= setup.target) {
          this.close(setup, 'TARGET_HIT', now);
          return setup;
        }
        if (spot <= setup.partialTakeAt) {
          this.bookPartial(setup, now);
          return setup;
        }
        if (spot >= setup.stoploss) {
          this.close(setup, 'STOPPED', now);
        }
      }
      return setup;
    }

    // PARTIAL_BOOKED: target still wins, otherwise ratchet trailing-SL
    // and exit the runner if it crosses.
    if (setup.status === 'PARTIAL_BOOKED') {
      const slDist = Math.abs(setup.entry - setup.stoploss);
      if (setup.side === 'BUY') {
        if (spot >= setup.target) {
          this.close(setup, 'TARGET_HIT', now);
          return setup;
        }
        // Trail 1×SL behind spot, never letting trailingSl move backward.
        const candidate = spot - slDist;
        if (setup.trailingSl == null || candidate > setup.trailingSl) {
          setup.trailingSl = candidate;
        }
        if (setup.trailingSl != null && spot <= setup.trailingSl) {
          setup.runnerExitAt = now;
          this.close(setup, 'TRAIL_STOPPED', now);
        }
      } else {
        if (spot <= setup.target) {
          this.close(setup, 'TARGET_HIT', now);
          return setup;
        }
        const candidate = spot + slDist;
        if (setup.trailingSl == null || candidate < setup.trailingSl) {
          setup.trailingSl = candidate;
        }
        if (setup.trailingSl != null && spot >= setup.trailingSl) {
          setup.runnerExitAt = now;
          this.close(setup, 'TRAIL_STOPPED', now);
        }
      }
    }
    return setup;
  }

  private bookPartial(setup: LockedSetup, now: Date): void {
    setup.status = 'PARTIAL_BOOKED';
    setup.partialBookedAt = now;
    // Anchor trailing-SL at entry (break-even) — guarantees the runner
    // can't turn the booked half into a net loss.
    setup.trailingSl = setup.entry;
    this.logger.log(
      `Setup ${setup.id} (${setup.symbol}) 50% booked at ${setup.partialTakeAt.toFixed(2)} → PARTIAL_BOOKED, trailingSl=${setup.entry.toFixed(2)}`,
    );
  }

  invalidate(token: string, reason?: string): void {
    const setup = this.active.get(token);
    if (!setup) return;
    if (!this.isOpen(setup.status)) return;
    this.close(setup, 'INVALIDATED', new Date());
    if (reason) {
      this.logger.log(`Setup ${setup.id} (${setup.symbol}) invalidated: ${reason}`);
    }
  }

  // Sweep is the safety-net: keeps PENDING/ACTIVE/PARTIAL_BOOKED setups
  // transitioning even when no analyze() call has come in for them lately.
  @Cron('*/30 * * * * *', { timeZone: 'Asia/Kolkata' })
  async sweep(): Promise<void> {
    if (this.active.size === 0) return;
    if (!this.marketFeed.isMarketOpen()) return;

    const now = new Date();
    for (const [token, setup] of this.active.entries()) {
      if (!this.isOpen(setup.status)) continue;
      const quote = this.marketFeed.getQuote(token);
      if (!quote) {
        // No live quote — can't evaluate against spot. Still check age.
        if (now.getTime() - setup.createdAt.getTime() >= EOD_AGE_MS) {
          this.close(setup, 'EOD', now);
        }
        continue;
      }
      this.updateFromTick(token, quote.ltp, now);
    }
  }

  // ─── internals ──────────────────────────────────────────────────

  private isOpen(status: SetupStatus): boolean {
    return (
      status === 'PENDING' ||
      status === 'ACTIVE' ||
      status === 'PARTIAL_BOOKED'
    );
  }

  private close(setup: LockedSetup, reason: SetupStatus, now: Date): void {
    setup.status = reason;
    setup.closeReason = reason;
    setup.closedAt = now;
    this.active.delete(setup.token);
    const list = this.history.get(setup.token) ?? [];
    list.unshift(setup);
    if (list.length > HISTORY_CAP_PER_TOKEN) {
      list.length = HISTORY_CAP_PER_TOKEN;
    }
    this.history.set(setup.token, list);
    this.logger.log(
      `Setup ${setup.id} (${setup.symbol}) closed: ${reason} high=${setup.high.toFixed(2)} low=${setup.low.toFixed(2)}`,
    );
  }

  private sessionEnded(exchange: string, now: Date): boolean {
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const ist = new Date(now.getTime() + istOffsetMs);
    const weekday = ist.getUTCDay(); // 0=Sun, 6=Sat
    if (weekday === 0 || weekday === 6) return true;
    const hh = ist.getUTCHours();
    const mm = ist.getUTCMinutes();
    const totalMin = hh * 60 + mm;
    const openMin = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MINUTE;
    const closeMin =
      exchange === 'MCX'
        ? MCX_CLOSE_HOUR * 60 + MCX_CLOSE_MINUTE
        : NSE_CLOSE_HOUR * 60 + NSE_CLOSE_MINUTE;
    return totalMin < openMin || totalMin > closeMin;
  }
}
