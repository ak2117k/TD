import { Injectable, Logger } from '@nestjs/common';
import { Prisma, WatchEventType, WatchStatus } from '@prisma/client';
import {
  UngatedWatchRepository, UngatedCreateEntryInput,
} from '../repositories/ungated-watch.repository';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import { UngatedPaperAccountService, TRADE_CAPITAL } from './ungated-paper-account.service';
import { UngatedTradeExecutionService } from './ungated-trade-execution.service';

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

    return entry;
  }
}
