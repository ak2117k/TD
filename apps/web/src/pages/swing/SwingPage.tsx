import React, { useState } from 'react';
import clsx from 'clsx';
import { useSwingEntries } from '../../hooks/useSwingEntries';
import { useSwingOpenBook } from '../../hooks/useSwingOpenBook';
import { summarizeOpenBook } from '../../utils/swingOpenBook';
import { CapitalStrip } from '../../components/anand/CapitalStrip';
import { SymbolChartLink } from '../../components/common';
import ChartinkScoreTable from '../../components/chartink/ChartinkScoreTable';
import type { AnandEntry, PnlPeriod, PnlSummary } from '../../services/anand';

const FILTERS = [
  { label: 'All', value: undefined },
  { label: 'Traded', value: 'TRADED' },
  { label: 'Target Hit', value: 'TARGET_HIT' },
  { label: 'Stopped', value: 'STOPPED' },
] as const;

const NOTIONAL = 200_000;

function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

const rsFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

function fmtRs(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}₹${rsFmt.format(Math.abs(n))}`;
}

function rsColor(n: number): string {
  if (n > 0) return 'text-emerald-400';
  if (n < 0) return 'text-red-400';
  return 'text-[var(--color-text-muted)]';
}

function fmtIstTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function fmtIstDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
  });
}

/** Collapse a lossless ISO-timestamp lead log to distinct IST calendar days, newest first. */
function distinctDays(isoList: string[]): string[] {
  const seen = new Set<string>();
  for (const iso of isoList) {
    seen.add(new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: '2-digit' }));
  }
  return [...seen].reverse();
}

function daysElapsed(enteredAt: string, exitedAt: string | null): number {
  const start = new Date(enteredAt).getTime();
  const end = exitedAt ? new Date(exitedAt).getTime() : Date.now();
  const d = Math.ceil((end - start) / 86_400_000);
  return d <= 0 ? 1 : d;
}

function PnlCard({ label, period }: { label: string; period: PnlPeriod }) {
  const hasTrades = period.count > 0;
  const value = hasTrades ? period.totalPnlRs : 0;
  return (
    <div className="flex-1 min-w-[140px] rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <div className={clsx('mt-1 text-lg font-semibold tabular-nums', hasTrades ? rsColor(value) : 'text-[var(--color-text-muted)]')}>
        {hasTrades ? fmtRs(value) : '—'}
      </div>
      <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
        {period.count}t · {period.winCount}W
      </div>
    </div>
  );
}

function PnlCards({ pnl }: { pnl: PnlSummary }) {
  return (
    <div className="flex flex-wrap gap-3">
      <PnlCard label="Daily P&L" period={pnl.daily} />
      <PnlCard label="Weekly P&L" period={pnl.weekly} />
      <PnlCard label="Monthly P&L" period={pnl.monthly} />
      <PnlCard label="Yearly P&L" period={pnl.yearly} />
    </div>
  );
}

function EntryRow({ entry }: { entry: AnandEntry }) {
  const [expanded, setExpanded] = useState(false);
  const ongoing = entry.exitPrice == null;
  const stale = entry.priceStale === true; // only set for open rows with no price
  const pnlPct = entry.pnlPct;
  const pnlColor =
    pnlPct == null ? 'text-[var(--color-text-muted)]' : pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400';
  const pnlRs = pnlPct == null ? null : (pnlPct / 100) * NOTIONAL;
  const statusColor: Record<string, string> = {
    TRADED: 'text-blue-400',
    TARGET_HIT: 'text-emerald-400',
    STOPPED: 'text-red-400',
  };

  return (
    <React.Fragment>
      <tr
        onClick={() => setExpanded((v) => !v)}
        className="cursor-pointer border-t border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-tertiary)]"
      >
        {/* 1. Symbol */}
        <td className="px-3 py-2 font-mono font-medium">
          <SymbolChartLink symbol={entry.symbol} token={entry.token} />
          {ongoing && (
            <span className="ml-2 rounded bg-amber-500/20 px-1 py-0.5 text-[9px] font-semibold uppercase text-amber-300">
              Overnight
            </span>
          )}
        </td>
        {/* 2. Scanner */}
        <td className="px-3 py-2 text-[var(--color-text-secondary)]">
          {entry.scannerName ?? <span className="text-[var(--color-text-muted)]">—</span>}
        </td>
        {/* Leads */}
        <td className="px-3 py-2 tabular-nums">
          {entry.leadCount && entry.leadCount > 0 ? (
            <span
              title={distinctDays(entry.leadDates ?? []).join('\n')}
              className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-xs font-semibold text-[var(--color-text-secondary)]"
            >
              ×{entry.leadCount}
            </span>
          ) : (
            <span className="text-[var(--color-text-muted)]">—</span>
          )}
        </td>
        {/* 3. Entry Price */}
        <td className="px-3 py-2 tabular-nums">₹{entry.entryPrice.toFixed(2)}</td>
        {/* 4. Price / Δ% */}
        <td className={clsx('px-3 py-2 tabular-nums', pnlColor)}>
          {stale ? (
            <span
              className="text-[var(--color-text-muted)]"
              title="No live price available right now — showing no data instead of a stale estimate"
            >
              —
              <span className="ml-1 rounded bg-amber-500/15 px-1 text-[9px] font-semibold uppercase text-amber-300">
                stale
              </span>
            </span>
          ) : (
            <>
              ₹{(ongoing ? (entry.currentPrice as number) : (entry.exitPrice as number)).toFixed(2)}
              {pnlPct != null && <span className="ml-1 text-xs">{fmtPct(pnlPct)}</span>}
            </>
          )}
        </td>
        {/* 5. P&L ₹ */}
        <td className={clsx('px-3 py-2 font-semibold tabular-nums', pnlRs == null ? 'text-[var(--color-text-muted)]' : rsColor(pnlRs))}>
          {pnlRs == null ? '—' : fmtRs(pnlRs)}
        </td>
        {/* 6. P&L % */}
        <td className={clsx('px-3 py-2 font-semibold tabular-nums', pnlColor)}>
          {pnlPct == null ? '—' : fmtPct(pnlPct)}
        </td>
        {/* 7. Target */}
        <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">{entry.targetPct}%</td>
        {/* 8. Status */}
        <td className={clsx('px-3 py-2 text-xs font-semibold uppercase tracking-wider', statusColor[entry.status] ?? 'text-gray-400')}>
          {entry.status.replace('_', ' ')}
        </td>
        {/* 9. Entry Time */}
        <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">{fmtIstTime(entry.enteredAt)}</td>
        {/* 10. Start Date */}
        <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">{fmtIstDate(entry.enteredAt)}</td>
        {/* 11. End Date */}
        <td className="px-3 py-2 tabular-nums">
          {entry.exitedAt ? (
            <span className="text-[var(--color-text-muted)]">{fmtIstDate(entry.exitedAt)}</span>
          ) : (
            <span className="italic text-gray-500">Ongoing</span>
          )}
        </td>
        {/* 12. Days */}
        <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">
          {daysElapsed(entry.enteredAt, entry.exitedAt)}d
        </td>
      </tr>
      {expanded && entry.scoreBreakdown && (
        <tr className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]/40">
          <td colSpan={13} className="px-3 py-2">
            <ChartinkScoreTable
              score={entry.scoreBreakdown.filter((c) => c.passed).reduce((s, c) => s + c.points, 0)}
              lotCount={0}
              checks={entry.scoreBreakdown}
            />
          </td>
        </tr>
      )}
    </React.Fragment>
  );
}

/** Shared table for both the Open Book and the date-filtered Entries log. */
function EntriesTable({
  entries,
  loading,
  error,
  emptyMessage,
}: {
  entries: AnandEntry[];
  loading: boolean;
  error: string | null;
  emptyMessage: string;
}) {
  if (loading) return <div className="text-[var(--color-text-muted)]">Loading…</div>;
  if (error) return <div className="text-red-400">Error: {error}</div>;
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
      <table className="w-full text-sm">
        <thead className="bg-[var(--color-bg-secondary)] text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
          <tr>
            <th className="px-3 py-2">Symbol</th>
            <th className="px-3 py-2">Scanner</th>
            <th className="px-3 py-2">Leads</th>
            <th className="px-3 py-2">Entry ₹</th>
            <th className="px-3 py-2">Price / Δ%</th>
            <th className="px-3 py-2">P&L ₹</th>
            <th className="px-3 py-2">P&L %</th>
            <th className="px-3 py-2">Target</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Entry Time</th>
            <th className="px-3 py-2">Start Date</th>
            <th className="px-3 py-2">End Date</th>
            <th className="px-3 py-2">Days</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr>
              <td colSpan={13} className="px-3 py-8 text-center text-[var(--color-text-muted)]">
                {emptyMessage}
              </td>
            </tr>
          )}
          {entries.map((e) => <EntryRow key={e.id} entry={e} />)}
        </tbody>
      </table>
    </div>
  );
}

export default function SwingPage() {
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [from, setFrom] = useState(todayIST());
  const { entries, pnl, loading, error } = useSwingEntries(filter, from);
  // Open Book: every currently-open position (status TRADED), with NO date
  // filter — the live-exposure source of truth. Kept separate from the
  // date-filtered `entries` above so overnight/multi-day positions are always
  // visible and counted, even when the From date excludes their entry day.
  const { openEntries, loading: openLoading, error: openError } = useSwingOpenBook();
  const { openCount, invested, currentValue, unrealizedRs } = summarizeOpenBook(openEntries, NOTIONAL);

  return (
    <div className="flex flex-col gap-4 p-6 text-[var(--color-text-primary)]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Swing Track</h1>
          <p className="text-sm text-[var(--color-text-muted)]">10% target · 10% stop · holds overnight</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-[var(--color-text-muted)]">{openCount} open</span>
          {openCount > 0 && (
            <span
              title="Unrealized P&L of open positions (mark-to-market, not yet booked)"
              className={clsx(
                'rounded bg-[var(--color-bg-tertiary)] px-2 py-1 text-xs font-semibold tabular-nums',
                rsColor(unrealizedRs),
              )}
            >
              {fmtRs(unrealizedRs)} unrealized
            </span>
          )}
        </div>
      </div>

      {openCount > 0 && (
        <CapitalStrip
          openCount={openCount}
          invested={invested}
          currentValue={currentValue}
          unrealizedRs={unrealizedRs}
        />
      )}

      {pnl && <PnlCards pnl={pnl} />}

      {/* Open Book — every currently-open position, always shown regardless of
          the date filter below. This is the live book that holds overnight. */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
          Open Book · {openCount} open
        </h2>
        <EntriesTable
          entries={openEntries}
          loading={openLoading}
          error={openError}
          emptyMessage="No open positions."
        />
      </section>

      {/* Entries log — date- and status-filtered history, for auditing what
          fired on a given day. These controls scope only this section. */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
          Entries
        </h2>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.label}
              onClick={() => setFilter(f.value)}
              className={clsx(
                'rounded px-3 py-1 text-sm transition-colors',
                filter === f.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
              )}
            >
              {f.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <label>From:</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded bg-[var(--color-bg-tertiary)] px-2 py-1 text-[var(--color-text-secondary)]"
            />
          </div>
        </div>

        <EntriesTable
          entries={entries}
          loading={loading}
          error={error}
          emptyMessage="No swing entries yet. Waiting for Anand Swing scanner alerts."
        />
      </section>
    </div>
  );
}
