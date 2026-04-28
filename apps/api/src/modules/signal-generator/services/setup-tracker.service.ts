import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { SetupContext } from '../types/setup-context.types';

export type SetupStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'TARGET_HIT'
  | 'STOPPED'
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
  grade: 'A' | 'B' | 'C';
  atr14: number;
  status: SetupStatus;
  createdAt: Date;
  triggeredAt: Date | null;
  closedAt: Date | null;
  closeReason: SetupStatus | null;
  high: number;
  low: number;
  indicators: SetupContext['indicators'];
  reason: string;
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
  grade: 'A' | 'B' | 'C';
  atr14: number;
  indicators: SetupContext['indicators'];
  reason: string;
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
      grade: input.grade,
      atr14: input.atr14,
      status: 'PENDING',
      createdAt: now,
      triggeredAt: null,
      closedAt: null,
      closeReason: null,
      high: input.entry,
      low: input.entry,
      indicators: input.indicators,
      reason: input.reason,
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

    // ACTIVE: evaluate target / stoploss
    if (setup.side === 'BUY') {
      if (spot >= setup.target) {
        this.close(setup, 'TARGET_HIT', now);
      } else if (spot <= setup.stoploss) {
        this.close(setup, 'STOPPED', now);
      }
    } else {
      if (spot <= setup.target) {
        this.close(setup, 'TARGET_HIT', now);
      } else if (spot >= setup.stoploss) {
        this.close(setup, 'STOPPED', now);
      }
    }
    return setup;
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

  // Sweep is the safety-net: keeps PENDING/ACTIVE setups transitioning
  // even when no analyze() call has come in for them lately.
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
    return status === 'PENDING' || status === 'ACTIVE';
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
