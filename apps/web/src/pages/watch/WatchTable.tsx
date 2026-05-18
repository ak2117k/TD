import { Fragment } from 'react';
import type { WatchEntry } from '../../types/watch.types';
import { profitView, isClosed } from '../../utils/watchPnl';
import { WatchDetailPanel } from './WatchDetailPanel';
import { factorCell, type FactorCellState } from './factorCell';

interface Props {
  entries: WatchEntry[];
  onSelect: (id: string | null) => void;
  selectedId: string | null;
}

function pctChange(curr: number | null, init: number): string {
  if (curr == null) return '—';
  const d = ((curr - init) / init) * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(2)}%`;
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

/** Time-of-day in IST (HH:MM:SS). The day itself is implied by the date filter. */
function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: 'Asia/Kolkata',
  });
}

/** The 10 scoring factors, in fixed column order (short header → full name). */
const FACTOR_COLUMNS: ReadonlyArray<{ name: string; short: string }> = [
  { name: 'Index aligned', short: 'Idx' },
  { name: 'Sector aligned', short: 'Sect' },
  { name: 'Relative strength', short: 'RS' },
  { name: 'Price vs 20-EMA', short: 'EMA' },
  { name: 'SuperTrend match', short: 'ST' },
  { name: 'MACD on 1d', short: 'M1d' },
  { name: 'MACD on 5m', short: 'M5m' },
  { name: 'MACD on 1m', short: 'M1m' },
  { name: 'S/R room', short: 'S/R' },
  { name: 'Volume confirmation', short: 'Vol' },
];

/** Extract the per-check results from a breakdown value (or [] if absent/malformed). */
function breakdownChecks(breakdown: unknown): Array<{ name: string; passed: boolean }> {
  const bd = breakdown as { checks?: Array<{ name: string; passed: boolean }> } | null;
  return Array.isArray(bd?.checks) ? bd!.checks : [];
}

/** Tailwind class for a factor cell, keyed by its transition state. */
const FACTOR_STATE_CLASS: Record<FactorCellState, string> = {
  same: '',
  decayed: 'text-red-400 font-medium bg-red-500/10 rounded',
  improved: 'text-emerald-300 font-medium bg-emerald-500/10 rounded',
};

export function WatchTable({ entries, onSelect, selectedId }: Props) {
  if (entries.length === 0) {
    return (
      <div className="p-6 text-center text-[var(--color-text-muted)]">
        No watch entries.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
    <table className="min-w-full text-sm text-[var(--color-text-primary)]">
      <thead className="text-xs text-[var(--color-text-muted)] border-b border-[var(--color-border-subtle)]">
        <tr>
          <th className="py-2 px-3 text-left">Symbol</th>
          <th className="py-2 px-3 text-left">Scanner</th>
          <th className="py-2 px-3 text-left">Side</th>
          <th
            className="py-2 px-3 text-right"
            title="Shares bought = floor(₹2,00,000 / reference price). Varies by stock price."
          >
            Qty
          </th>
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
          <th className="py-2 px-3 text-right" title="Order fill time — or the alert time if never traded (IST)">Buy Time</th>
          <th className="py-2 px-3 text-right" title="Position close / alert stop time (IST)">Sell Time</th>
          <th className="py-2 px-3 text-right">Score</th>
          {FACTOR_COLUMNS.map((f) => (
            <th
              key={f.name}
              className="py-2 px-2 text-center font-medium"
              title={`${f.name} — live value; ✓→✗ decayed / ✗→✓ improved since entry`}
            >
              {f.short}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => {
          const p = profitView(e);
          // Buy-time pass/fail per factor.
          const initialByName = new Map(
            breakdownChecks(e.initialBreakdown).map((c) => [c.name, c.passed]),
          );
          // Live pass/fail per factor — falls back to buy-time when never rescored.
          const currentByName = new Map(
            breakdownChecks(e.currentBreakdown ?? e.initialBreakdown).map((c) => [c.name, c.passed]),
          );
          return (
            <Fragment key={e.id}>
            <tr
              onClick={() => onSelect(e.id === selectedId ? null : e.id)}
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
              <td
                className="py-2 px-3 text-left text-[var(--color-text-secondary)] max-w-[160px] truncate"
                title={e.scannerName ?? undefined}
              >
                {e.scannerName ?? '—'}
              </td>
              <td className="py-2 px-3 text-[var(--color-text-secondary)]">{e.side}</td>
              <td
                className="py-2 px-3 text-right tabular-nums text-[var(--color-text-primary)]"
                title={`₹${(p.qty * p.ref).toLocaleString('en-IN', { maximumFractionDigits: 0 })} deployed @ ₹${p.ref.toFixed(2)}`}
              >
                {p.qty.toLocaleString('en-IN')}
              </td>
              <td className="py-2 px-3 text-right text-[var(--color-text-primary)]">
                {e.currentPrice?.toFixed(2) ?? e.initialPrice.toFixed(2)}
              </td>
              <td className="py-2 px-3 text-right text-[var(--color-text-secondary)]">
                {pctChange(e.currentPrice, e.initialPrice)}
              </td>
              {isClosed(e.status) ? (
                e.realizedPnl != null ? (
                  // Executed & closed → realized P&L from the linked trade.
                  <>
                    <td className={`py-2 px-3 text-right font-medium tabular-nums ${
                      e.realizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {fmtRupees(e.realizedPnl)}
                    </td>
                    <td className={`py-2 px-3 text-right tabular-nums ${
                      e.realizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {`${e.realizedPnl >= 0 ? '+' : ''}${(
                        (e.realizedPnl / Math.max(p.ref * p.qty, 1)) * 100
                      ).toFixed(2)}%`}
                    </td>
                  </>
                ) : (
                  // Never traded → "what-if" P&L (price-based, hypothetical).
                  // Marked with ~ and a tooltip so it is not read as real money.
                  <>
                    <td
                      className={`py-2 px-3 text-right tabular-nums ${profitColor(p.abs, p.hasLivePrice)}`}
                      title="What-if P&L — this alert was never traded"
                    >
                      ~{fmtRupees(p.abs)}
                    </td>
                    <td
                      className={`py-2 px-3 text-right tabular-nums ${profitColor(p.abs, p.hasLivePrice)}`}
                      title="What-if — this alert was never traded"
                    >
                      ~{p.pct >= 0 ? '+' : ''}{p.pct.toFixed(2)}%
                    </td>
                  </>
                )
              ) : (
                <>
                  <td
                    className={`py-2 px-3 text-right font-medium tabular-nums ${profitColor(p.abs, p.hasLivePrice)}`}
                    title={`${p.qty} shares @ ₹${p.ref.toFixed(2)} = ₹${(p.qty * p.ref).toFixed(0)} invested`}
                  >
                    {p.hasLivePrice ? fmtRupees(p.abs) : '—'}
                  </td>
                  <td className={`py-2 px-3 text-right tabular-nums ${profitColor(p.abs, p.hasLivePrice)}`}>
                    {p.hasLivePrice ? `${p.pct >= 0 ? '+' : ''}${p.pct.toFixed(2)}%` : '—'}
                  </td>
                </>
              )}
              <td className="py-2 px-3 text-right text-[var(--color-text-secondary)]">
                {e.profitTarget.toFixed(2)}
              </td>
              <td className={`py-2 px-3 font-medium ${statusColor(e.status)}`}>{e.status}</td>
              <td className="py-2 px-3 text-right tabular-nums text-[var(--color-text-secondary)]">
                {fmtTime(e.executedAt ?? e.initialAt)}
              </td>
              <td className="py-2 px-3 text-right tabular-nums text-[var(--color-text-secondary)]">
                {fmtTime(e.closedAt)}
              </td>
              <td className="py-2 px-3 text-right text-[var(--color-text-primary)]">
                {e.initialScore}
                {e.currentScore != null && e.currentScore !== e.initialScore ? (
                  <> → <strong>{e.currentScore}</strong></>
                ) : null}
              </td>
              {FACTOR_COLUMNS.map((f) => {
                const initial = initialByName.get(f.name);
                const current = currentByName.get(f.name);
                // No data for this factor at all → render the neutral dot.
                if (initial === undefined || current === undefined) {
                  return (
                    <td key={f.name} className="py-2 px-2 text-center">
                      <span className="text-[var(--color-text-muted)]">·</span>
                    </td>
                  );
                }
                const cell = factorCell(initial, current);
                const title =
                  cell.state === 'decayed'
                    ? `${f.name} — passed at entry, now failing`
                    : cell.state === 'improved'
                    ? `${f.name} — failed at entry, now passing`
                    : `${f.name} — ${current ? 'aligned' : 'not aligned'}`;
                const sameClass = current ? 'text-emerald-400' : 'text-red-400/60';
                return (
                  <td key={f.name} className="py-2 px-2 text-center" title={title}>
                    <span
                      className={
                        cell.state === 'same'
                          ? sameClass
                          : `px-1 py-0.5 ${FACTOR_STATE_CLASS[cell.state]}`
                      }
                    >
                      {cell.text}
                    </span>
                  </td>
                );
              })}
            </tr>
            {e.id === selectedId && (
              <tr>
                <td
                  colSpan={23}
                  className="p-2 bg-[var(--color-bg-tertiary)]/40 border-b border-[var(--color-border-subtle)]"
                >
                  <WatchDetailPanel entryId={e.id} onClose={() => onSelect(null)} />
                </td>
              </tr>
            )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}
