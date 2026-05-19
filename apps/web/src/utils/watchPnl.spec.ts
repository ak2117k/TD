import { describe, it, expect } from 'vitest';
import {
  sectionTotalPnl, pnlBreakdown, breakdownChecks, profitView, accountRealPnl,
} from './watchPnl';
import type { WatchEntry } from '../types/watch.types';

function entry(o: Partial<WatchEntry>): WatchEntry {
  return {
    id: 'w', alertId: null, setupId: null, symbol: 'X', token: '1', exchange: 'NSE',
    side: 'BUY', initialPrice: 100, initialScore: 60, initialBreakdown: null,
    currentBreakdown: null, initialAt: '', profitTarget: 110,
    profitTargetSource: 'fallback-2pct',
    stopLossScore: 60, status: 'WATCHING', currentPrice: null, currentScore: null,
    maxFavorable: null, maxAdverse: null, lastTickAt: null, lastRescoreAt: null,
    optionsToken: null, optionsType: null, optionsExpiry: null, optionsStrike: null,
    optionsLotSize: null, optionsSelectionScore: null, paperTradeId: null,
    liveTradeId: null, executedAt: null, executedPrice: null, quantity: null, closedAt: null,
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

describe('pnlBreakdown', () => {
  it('separates realized, open (live), and what-if', () => {
    const realized = entry({ status: 'STOPPED', realizedPnl: -1500 });
    const open = entry({ status: 'TRADED', executedPrice: 100, currentPrice: 105 }); // +10,000
    const untraded = entry({ status: 'WATCHING', initialPrice: 100, currentPrice: 103 }); // +6,000
    const b = pnlBreakdown([realized, open, untraded]);
    expect(b.realized).toBe(-1500);
    expect(b.open).toBeCloseTo(10000, 0);
    expect(b.whatIf).toBeCloseTo(6000, 0);
    expect(b.real).toBeCloseTo(8500, 0); // realized + open, excludes what-if
  });

  it('counts a DISMISSED never-traded entry as what-if, never as real', () => {
    const dismissed = entry({ status: 'DISMISSED', initialPrice: 100, currentPrice: 110, realizedPnl: null });
    const b = pnlBreakdown([dismissed]);
    expect(b.whatIf).toBeCloseTo(20000, 0); // (110-100) * floor(200000/100)
    expect(b.real).toBe(0);
  });

  it('real + whatIf equals sectionTotalPnl (same buckets, just split)', () => {
    const mixed = [
      entry({ status: 'TARGET_HIT', executedPrice: 100, currentPrice: 999, realizedPnl: 4200 }),
      entry({ status: 'TRADED', executedPrice: 100, currentPrice: 105 }),
      entry({ status: 'WATCHING', initialPrice: 100, currentPrice: 103 }),
    ];
    const b = pnlBreakdown(mixed);
    expect(b.real + b.whatIf).toBeCloseTo(sectionTotalPnl(mixed), 0);
  });

  it('uses the account unrealized P&L for the open slice when provided', () => {
    const realizedTrade = entry({ status: 'STOPPED', realizedPnl: -1800 });
    // The watch-entry currentPrice would estimate open at +10,000, but that
    // is stale (WebSocket-fed). The paper account's REST-priced figure (+2,105)
    // is authoritative and must replace the watch-entry estimate.
    const openPos = entry({ status: 'TRADED', executedPrice: 100, currentPrice: 105 });
    const b = pnlBreakdown([realizedTrade, openPos], 2105);
    expect(b.open).toBe(2105);
    expect(b.real).toBe(-1800 + 2105); // realized + fresh open
  });

  it('falls back to the watch-entry open when no account value is given', () => {
    const openPos = entry({ status: 'TRADED', executedPrice: 100, currentPrice: 105 });
    expect(pnlBreakdown([openPos]).open).toBeCloseTo(10000, 0); // undefined
    expect(pnlBreakdown([openPos], null).open).toBeCloseTo(10000, 0); // null
  });
});

describe('profitView', () => {
  it('uses entry.quantity for the position size, not floor(MAX/price)', () => {
    // executedPrice 100 → the floor(200000/100) estimate would be 2000;
    // the real filled quantity is 1500.
    const e = entry({ status: 'TRADED', executedPrice: 100, currentPrice: 105, quantity: 1500 });
    const v = profitView(e);
    expect(v.qty).toBe(1500);
    expect(v.abs).toBeCloseTo(7500, 0); // (105-100) * 1500
  });

  it('uses remainingQty (trailing remainder) over the full quantity after a partial exit', () => {
    const e = entry({
      status: 'TRADED', executedPrice: 100, currentPrice: 105,
      quantity: 1500, remainingQty: 750,
    });
    expect(profitView(e).qty).toBe(750);
  });

  it('falls back to floor(MAX/price) when quantity is absent (legacy entry)', () => {
    const e = entry({ status: 'TRADED', executedPrice: 100, currentPrice: 105, quantity: null });
    expect(profitView(e).qty).toBe(2000); // floor(200000 / 100)
  });
});

describe('accountRealPnl', () => {
  // equity = balance + deployedCapital + unrealizedPnl + pendingProfit
  const acct = {
    startingCapital: 2_000_000,
    balance: 1_500_000,
    deployedCapital: 480_000,
    unrealizedPnl: 3_000,
    pendingProfit: 12_000,
    equity: 1_995_000, // 1,500,000 + 480,000 + 3,000 + 12,000
  };

  it('total is equity minus starting capital — the authoritative account P&L', () => {
    expect(accountRealPnl(acct).total).toBe(-5_000); // 1,995,000 - 2,000,000
  });

  it('decomposes into realized + unrealized + pending, which sum to total', () => {
    const r = accountRealPnl(acct);
    expect(r.unrealized).toBe(3_000);
    expect(r.pending).toBe(12_000);
    expect(r.realized).toBe(-20_000); // balance + deployed - starting
    expect(r.realized + r.unrealized + r.pending).toBeCloseTo(r.total, 6);
  });
});

describe('breakdownChecks', () => {
  const checks = [{ name: 'Idx', passed: true }];

  it('reads the wrapped { checks: [...] } shape (initialBreakdown / new currentBreakdown)', () => {
    expect(breakdownChecks({ checks })).toEqual(checks);
  });

  it('reads a bare [...] array (legacy currentBreakdown shape)', () => {
    expect(breakdownChecks(checks)).toEqual(checks);
  });

  it('returns [] for null / undefined / malformed input', () => {
    expect(breakdownChecks(null)).toEqual([]);
    expect(breakdownChecks(undefined)).toEqual([]);
    expect(breakdownChecks({ foo: 1 })).toEqual([]);
  });
});
