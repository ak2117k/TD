import { describe, it, expect } from 'vitest';
import { summarizeOpenBook } from './swingOpenBook';
import type { AnandEntry } from '../services/anand';

function entry(o: Partial<AnandEntry>): AnandEntry {
  return {
    id: 's', symbol: 'X', token: '1', entryPrice: 100, enteredAt: '2026-06-04T08:00:00.000Z',
    targetPct: 10, stopPct: 10, status: 'TRADED', exitPrice: null, exitedAt: null,
    currentPrice: 100, pnlPct: 0, targetLeftPct: 10, scannerName: null, scoreBreakdown: null,
    ...o,
  };
}

const NOTIONAL = 200_000;

describe('summarizeOpenBook', () => {
  it('empty list yields zero count and zero unrealized', () => {
    expect(summarizeOpenBook([], NOTIONAL)).toEqual({ openCount: 0, unrealizedRs: 0 });
  });

  it('counts every position and sums mark-to-market unrealized across mixed signs', () => {
    const winner = entry({ pnlPct: 5 });   // +5% of 200k = +10,000
    const loser = entry({ pnlPct: -2 });   // -2% of 200k = -4,000
    const flat = entry({ pnlPct: 0 });     // 0
    const r = summarizeOpenBook([winner, loser, flat], NOTIONAL);
    expect(r.openCount).toBe(3);
    expect(r.unrealizedRs).toBeCloseTo(6000, 6); // 10000 - 4000 + 0
  });

  it('counts a stale position in openCount but excludes it from unrealized', () => {
    // A position with no live price (pnlPct null) is still open — count it — but
    // its unrealized P&L is unknown, so it must NOT be summed as if it were 0%.
    const live = entry({ pnlPct: 5 });                              // +10,000
    const stale = entry({ pnlPct: null, currentPrice: null, priceStale: true });
    const r = summarizeOpenBook([live, stale], NOTIONAL);
    expect(r.openCount).toBe(2);
    expect(r.unrealizedRs).toBeCloseTo(10000, 6);
  });

  it('is independent of entry dates — positions from different days all contribute', () => {
    // The helper takes no date argument: a position entered yesterday must count
    // exactly the same as one entered today. This is the decoupling guarantee.
    const yesterday = entry({ enteredAt: '2026-06-04T07:40:00.000Z', pnlPct: 3 });
    const today = entry({ enteredAt: '2026-06-05T09:20:00.000Z', pnlPct: 1 });
    const r = summarizeOpenBook([yesterday, today], NOTIONAL);
    expect(r.openCount).toBe(2);
    expect(r.unrealizedRs).toBeCloseTo(8000, 6); // (3% + 1%) of 200k
  });
});
