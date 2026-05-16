import { describe, it, expect } from 'vitest';
import { sectionTotalPnl } from './watchPnl';
import type { WatchEntry } from '../types/watch.types';

function entry(o: Partial<WatchEntry>): WatchEntry {
  return {
    id: 'w', alertId: null, setupId: null, symbol: 'X', token: '1', exchange: 'NSE',
    side: 'BUY', initialPrice: 100, initialScore: 60, initialBreakdown: null,
    initialAt: '', profitTarget: 110, profitTargetSource: 'fallback-2pct',
    stopLossScore: 60, status: 'WATCHING', currentPrice: null, currentScore: null,
    maxFavorable: null, maxAdverse: null, lastTickAt: null, lastRescoreAt: null,
    optionsToken: null, optionsType: null, optionsExpiry: null, optionsStrike: null,
    optionsLotSize: null, optionsSelectionScore: null, paperTradeId: null,
    liveTradeId: null, executedAt: null, executedPrice: null, closedAt: null,
    closedReason: null, notes: null, partialExitedAt: null, partialExitPrice: null,
    partialQty: null, remainingQty: null, trailingHighWater: null,
    trailingStopPrice: null, scannerName: null, realizedPnl: null,
    createdAt: '', updatedAt: '', ...o,
  };
}

describe('sectionTotalPnl', () => {
  it('open entries contribute live price-based P/L', () => {
    // TRADED, executed @100, live 105, qty floor(200000/100)=2000 → +10,000
    const e = entry({ status: 'TRADED', executedPrice: 100, currentPrice: 105 });
    expect(sectionTotalPnl([e])).toBeCloseTo(10000, 0);
  });

  it('closed entries contribute realized pnl, not price estimate', () => {
    const e = entry({ status: 'TARGET_HIT', executedPrice: 100, currentPrice: 999, realizedPnl: 4200 });
    expect(sectionTotalPnl([e])).toBe(4200);
  });

  it('closed entry that never traded contributes its what-if P/L (matches the column)', () => {
    // STOPPED, never executed (realizedPnl null), price moved 100 → 105.
    // qty = floor(200000/100) = 2000 → what-if = (105-100)*2000 = 10,000
    const e = entry({ status: 'STOPPED', initialPrice: 100, currentPrice: 105, realizedPnl: null });
    expect(sectionTotalPnl([e])).toBeCloseTo(10000, 0);
  });

  it('closed entry that never traded and never moved contributes ₹0', () => {
    const e = entry({ status: 'STOPPED', initialPrice: 100, currentPrice: null, realizedPnl: null });
    expect(sectionTotalPnl([e])).toBe(0);
  });

  it('sums a mixed section', () => {
    const open = entry({ status: 'TRADED', executedPrice: 100, currentPrice: 105 }); // +10,000
    const closed = entry({ status: 'STOPPED', realizedPnl: -1500 });
    expect(sectionTotalPnl([open, closed])).toBeCloseTo(8500, 0);
  });
});
