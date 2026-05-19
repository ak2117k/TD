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

export interface PnlBreakdown {
  /** Booked P/L from trades that actually closed. Real money. */
  realized: number;
  /** Live unrealized P/L of currently-open (TRADED) positions. Real money. */
  open: number;
  /** Hypothetical P/L of alerts that were scored but never traded. NOT real. */
  whatIf: number;
  /** Real P/L = realized + open. Excludes what-if. */
  real: number;
}

/**
 * Split a watch section's P/L into real money (realized + currently-open) vs
 * hypothetical "what-if" P/L from alerts that were never actually traded — so
 * the header can show the two separately instead of one misleading blend.
 *
 * `accountUnrealizedPnl` — when given (the paper account's `unrealizedPnl`) —
 * replaces the watch-entry-derived `open` slice. The paper account is priced
 * from fresh REST quotes, whereas the watch entries' `currentPrice` is fed by
 * the (token-capped, often stale) WebSocket — so the account figure is the
 * authoritative one, and using it keeps "Real P/L" in sync with the Unreal
 * badge (real === Unreal + realized). When omitted, `open` falls back to the
 * watch-entry estimate.
 *
 * A never-traded entry stays "what-if" even after it is DISMISSED — only
 * entries that genuinely traded are "real".
 */
export function pnlBreakdown(
  entries: WatchEntry[],
  accountUnrealizedPnl?: number | null,
): PnlBreakdown {
  let realized = 0;
  let openFromEntries = 0;
  let whatIf = 0;
  for (const e of entries) {
    if (isClosed(e.status) && e.realizedPnl != null) {
      realized += e.realizedPnl;
    } else if (e.status === 'TRADED') {
      openFromEntries += profitView(e).abs;
    } else {
      whatIf += profitView(e).abs;
    }
  }
  const open =
    accountUnrealizedPnl != null ? accountUnrealizedPnl : openFromEntries;
  return { realized, open, whatIf, real: realized + open };
}
