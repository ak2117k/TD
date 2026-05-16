import type { WatchEntry } from '../types/watch.types';

/** Max ₹ deployed per trade — mirrors backend MAX_INVESTMENT_PER_TRADE.
 *  Per-row quantity is floor(this / referencePrice) so P&L scales with stock price. */
export const MAX_INVESTMENT_PER_TRADE = 200_000;

export interface ProfitView {
  abs: number;
  pct: number;
  ref: number;
  qty: number;
  hasLivePrice: boolean;
}

/**
 * Live price-based P/L for an open entry: currentPrice vs reference
 * (executedPrice for TRADED, initialPrice for WATCHING), side-adjusted,
 * × dynamic qty = floor(MAX_INVESTMENT_PER_TRADE / ref).
 */
export function profitView(entry: WatchEntry): ProfitView {
  const ref = entry.executedPrice ?? entry.initialPrice;
  const curr = entry.currentPrice ?? ref;
  const sideMul = entry.side === 'BUY' ? 1 : -1;
  const diff = (curr - ref) * sideMul;
  const qty = Math.max(1, Math.floor(MAX_INVESTMENT_PER_TRADE / Math.max(ref, 1)));
  return {
    abs: diff * qty,
    pct: ref > 0 ? (diff / ref) * 100 : 0,
    ref,
    qty,
    hasLivePrice: entry.currentPrice != null,
  };
}

const CLOSED: ReadonlyArray<string> = ['STOPPED', 'TARGET_HIT', 'EXITED', 'DISMISSED'];

export function isClosed(status: string): boolean {
  return CLOSED.includes(status);
}

/**
 * Section running total — sums each entry's P/L exactly as the P&L column
 * displays it: realized P/L for a closed row that actually traded, otherwise
 * the price-based live / what-if P/L. So the badge always equals the column.
 */
export function sectionTotalPnl(entries: WatchEntry[]): number {
  return entries.reduce((total, e) => {
    if (isClosed(e.status) && e.realizedPnl != null) {
      return total + e.realizedPnl;
    }
    return total + profitView(e).abs;
  }, 0);
}
