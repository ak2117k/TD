import React, { useState } from 'react';
import clsx from 'clsx';
import { useIntradayEntries } from '../../hooks/useIntradayEntries';
import ChartinkScoreTable from '../../components/chartink/ChartinkScoreTable';
import type { AnandEntry, PnlSummary } from '../../services/anand';

const FILTERS = [
  { label: 'All', value: undefined },
  { label: 'Watching', value: 'WATCHING' },
  { label: 'Target Hit', value: 'TARGET_HIT' },
  { label: 'Stopped', value: 'STOPPED' },
  { label: 'Expired', value: 'EXPIRED' },
] as const;

function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function PnlBar({ pnl }: { pnl: PnlSummary }) {
  const fmt = (p: { avgExitPct: number; count: number; winCount: number }) =>
    p.count ? `${fmtPct(p.avgExitPct)} (${p.winCount}W/${p.count})` : '—';
  return (
    <div className="flex flex-wrap gap-6 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-4 py-3 text-sm">
      {(['daily', 'weekly', 'monthly', 'yearly'] as const).map((k) => (
        <div key={k}>
          <span className="text-[var(--color-text-muted)] capitalize">{k}: </span>
          <span className={clsx('font-semibold tabular-nums', pnl[k].avgExitPct >= 0 ? 'text-emerald-400' : 'text-red-400')}>
            {fmt(pnl[k])}
          </span>
        </div>
      ))}
    </div>
  );
}

function EntryRow({ entry }: { entry: AnandEntry }) {
  const [expanded, setExpanded] = useState(false);
  const pnlColor = entry.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400';
  const statusColor: Record<string, string> = {
    WATCHING: 'text-blue-400',
    TARGET_HIT: 'text-emerald-400',
    STOPPED: 'text-red-400',
    EXPIRED: 'text-gray-400',
  };

  return (
    <React.Fragment>
      <tr
        onClick={() => setExpanded((v) => !v)}
        className="cursor-pointer border-t border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-tertiary)]"
      >
        <td className="px-3 py-2 font-mono font-medium">{entry.symbol}</td>
        <td className="px-3 py-2 tabular-nums">₹{entry.entryPrice.toFixed(2)}</td>
        <td className="px-3 py-2 text-[var(--color-text-muted)] tabular-nums">
          {new Date(entry.enteredAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
        </td>
        <td className={clsx('px-3 py-2 font-semibold tabular-nums', pnlColor)}>
          {fmtPct(entry.pnlPct)}
        </td>
        <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">
          {entry.status === 'WATCHING' ? fmtPct(entry.targetLeftPct) : '—'}
        </td>
        <td className={clsx('px-3 py-2 text-xs font-semibold uppercase tracking-wider', statusColor[entry.status] ?? 'text-gray-400')}>
          {entry.status.replace('_', ' ')}
        </td>
      </tr>
      {expanded && entry.scoreBreakdown && (
        <tr className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]/40">
          <td colSpan={6} className="px-3 py-2">
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

export default function IntradayPage() {
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [date, setDate] = useState(todayIST());
  const { entries, pnl, loading, error } = useIntradayEntries(filter, date);
  const activeCount = entries.filter((e) => e.status === 'WATCHING').length;

  return (
    <div className="flex flex-col gap-4 p-6 text-[var(--color-text-primary)]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Intraday Track</h1>
          <p className="text-sm text-[var(--color-text-muted)]">5% target · 5% stop · expires at 15:15</p>
        </div>
        <div className="text-sm text-[var(--color-text-muted)]">{activeCount} watching</div>
      </div>

      {pnl && <PnlBar pnl={pnl} />}

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
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="ml-auto rounded bg-[var(--color-bg-tertiary)] px-2 py-1 text-sm text-[var(--color-text-secondary)]"
        />
      </div>

      {loading && <div className="text-[var(--color-text-muted)]">Loading…</div>}
      {error && <div className="text-red-400">Error: {error}</div>}
      {!loading && !error && (
        <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg-secondary)] text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
              <tr>
                <th className="px-3 py-2">Symbol</th>
                <th className="px-3 py-2">Entry ₹</th>
                <th className="px-3 py-2">Date & Time</th>
                <th className="px-3 py-2">P/L %</th>
                <th className="px-3 py-2">Target Left</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-[var(--color-text-muted)]">
                    No entries yet. Tag an Anand Swing scanner as ANAND_SWING to start auto-logging.
                  </td>
                </tr>
              )}
              {entries.map((e) => <EntryRow key={e.id} entry={e} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
