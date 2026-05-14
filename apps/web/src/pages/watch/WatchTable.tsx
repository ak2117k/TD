import type { WatchEntry } from '../../types/watch.types';

interface Props {
  entries: WatchEntry[];
  onSelect: (id: string) => void;
  selectedId: string | null;
}

/** Max ₹ deployed per trade — mirrors backend MAX_INVESTMENT_PER_TRADE.
 *  Per-row quantity is floor(this / referencePrice) so P&L scales with stock price. */
const MAX_INVESTMENT_PER_TRADE = 200_000;

function pctChange(curr: number | null, init: number): string {
  if (curr == null) return '—';
  const d = ((curr - init) / init) * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(2)}%`;
}

interface ProfitView {
  abs: number;
  pct: number;
  ref: number;
  qty: number;
  hasLivePrice: boolean;
}

/**
 * Compute running profit using the entry's live currentPrice (updates as
 * WS ticks arrive) against the reference price:
 *   - TRADED entries → executedPrice (real P&L from the broker fill)
 *   - WATCHING entries → initialPrice (potential / what-if P&L if entered now)
 *
 * Side flips the sign: SELL profits when price drops.
 * Qty is dynamic: floor(MAX_INVESTMENT_PER_TRADE / ref) so ₹ deployed is
 * consistent (~₹2L) regardless of per-share price.
 */
function profitView(entry: WatchEntry): ProfitView {
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

function statusColor(status: string): string {
  switch (status) {
    case 'WATCHING': return 'text-blue-400';
    case 'TRADED': return 'text-emerald-400';
    case 'TARGET_HIT': return 'text-emerald-300';
    case 'STOPPED': return 'text-red-400';
    case 'EXITED': return 'text-[var(--color-text-muted)]';
    case 'DISMISSED': return 'text-[var(--color-text-muted)]';
    default: return 'text-[var(--color-text-secondary)]';
  }
}

function profitColor(abs: number, hasLivePrice: boolean): string {
  if (!hasLivePrice) return 'text-[var(--color-text-muted)]';
  if (abs > 0) return 'text-emerald-400';
  if (abs < 0) return 'text-red-400';
  return 'text-[var(--color-text-secondary)]';
}

function fmtRupees(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}₹${Math.abs(n) < 1 ? n.toFixed(2) : n.toFixed(0)}`;
}

export function WatchTable({ entries, onSelect, selectedId }: Props) {
  if (entries.length === 0) {
    return (
      <div className="p-6 text-center text-[var(--color-text-muted)]">
        No watch entries.
      </div>
    );
  }
  return (
    <table className="w-full text-sm text-[var(--color-text-primary)]">
      <thead className="text-xs text-[var(--color-text-muted)] border-b border-[var(--color-border-subtle)]">
        <tr>
          <th className="py-2 px-3 text-left">Symbol</th>
          <th className="py-2 px-3 text-left">Side</th>
          <th className="py-2 px-3 text-right">Score</th>
          <th className="py-2 px-3 text-right">Price</th>
          <th className="py-2 px-3 text-right">Δ%</th>
          <th
            className="py-2 px-3 text-right"
            title="Running P&L at ₹2L max investment per trade (qty varies by stock price)"
          >
            P&amp;L
          </th>
          <th className="py-2 px-3 text-right">P&amp;L %</th>
          <th className="py-2 px-3 text-right">Target</th>
          <th className="py-2 px-3 text-left">Status</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => {
          const p = profitView(e);
          return (
            <tr
              key={e.id}
              onClick={() => onSelect(e.id)}
              className={`border-b border-[var(--color-border-subtle)] cursor-pointer transition-colors ${
                e.id === selectedId
                  ? 'bg-[var(--color-bg-tertiary)]'
                  : 'hover:bg-[var(--color-bg-tertiary)]/50'
              }`}
            >
              <td className="py-2 px-3 font-mono text-[var(--color-text-primary)]">
                {e.symbol}
                {e.partialExitedAt && (
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                    ½ exit · trail ₹{e.trailingStopPrice?.toFixed(2)}
                  </span>
                )}
              </td>
              <td className="py-2 px-3 text-[var(--color-text-secondary)]">{e.side}</td>
              <td className="py-2 px-3 text-right text-[var(--color-text-primary)]">
                {e.initialScore}
                {e.currentScore != null && e.currentScore !== e.initialScore ? (
                  <> → <strong>{e.currentScore}</strong></>
                ) : null}
              </td>
              <td className="py-2 px-3 text-right text-[var(--color-text-primary)]">
                {e.currentPrice?.toFixed(2) ?? e.initialPrice.toFixed(2)}
              </td>
              <td className="py-2 px-3 text-right text-[var(--color-text-secondary)]">
                {pctChange(e.currentPrice, e.initialPrice)}
              </td>
              <td
                className={`py-2 px-3 text-right font-medium tabular-nums ${profitColor(p.abs, p.hasLivePrice)}`}
                title={`${p.qty} shares @ ₹${p.ref.toFixed(2)} = ₹${(p.qty * p.ref).toFixed(0)} invested`}
              >
                {p.hasLivePrice ? fmtRupees(p.abs) : '—'}
              </td>
              <td className={`py-2 px-3 text-right tabular-nums ${profitColor(p.abs, p.hasLivePrice)}`}>
                {p.hasLivePrice
                  ? `${p.pct >= 0 ? '+' : ''}${p.pct.toFixed(2)}%`
                  : '—'}
              </td>
              <td className="py-2 px-3 text-right text-[var(--color-text-secondary)]">
                {e.profitTarget.toFixed(2)}
              </td>
              <td className={`py-2 px-3 font-medium ${statusColor(e.status)}`}>{e.status}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
