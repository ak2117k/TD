import type { AnandEntry } from '../services/anand';

export interface OpenBookSummary {
  /** How many positions are currently open (status TRADED / exitPrice null). */
  openCount: number;
  /** Mark-to-market unrealized P&L of those open positions, in rupees. */
  unrealizedRs: number;
}

/**
 * Summarise the open swing book — the live-exposure counter shown in the page
 * header. Takes ONLY the open positions and the notional; it has no notion of a
 * date filter, by design. The whole point of the Open Book is that this number
 * reflects every currently-open position regardless of when it was entered, so
 * the helper cannot be coupled to the page's `from` date even by accident.
 */
export function summarizeOpenBook(openEntries: AnandEntry[], notional: number): OpenBookSummary {
  return {
    // Every open position counts toward openCount — including stale ones, which
    // are still live exposure. But a stale position (pnlPct null) has unknown
    // unrealized P&L, so it is excluded from the sum rather than treated as 0%.
    openCount: openEntries.length,
    unrealizedRs: openEntries.reduce(
      (sum, e) => sum + (e.pnlPct == null ? 0 : (e.pnlPct / 100) * notional),
      0,
    ),
  };
}
