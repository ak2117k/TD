import { useState } from 'react';
import { useWatchEntries } from '../../hooks/useWatchEntries';
import { WatchTable } from './WatchTable';
import { PaperAccountBadge } from '../../components/trading/PaperAccountBadge';
import { pnlBreakdown } from '../../utils/watchPnl';
import { usePaperAccount } from '../../hooks/usePaperAccount';
import type { WatchStatus } from '../../types/watch.types';

const FILTERS: Array<{ label: string; value: WatchStatus | undefined }> = [
  { label: 'All', value: undefined },
  { label: 'Watching', value: 'WATCHING' },
  { label: 'Traded', value: 'TRADED' },
  { label: 'Stopped', value: 'STOPPED' },
  { label: 'Target Hit', value: 'TARGET_HIT' },
];

/** Today's date as YYYY-MM-DD in IST (en-CA locale yields ISO format). */
function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export function WatchPage() {
  const [filter, setFilter] = useState<WatchStatus | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [date, setDate] = useState<string>(todayIST());
  const { entries, loading, error } = useWatchEntries(filter, date);
  const { account } = usePaperAccount();
  const activeCount = entries.filter(e => e.status === 'WATCHING' || e.status === 'TRADED').length;

  return (
    <div className="p-6 text-[var(--color-text-primary)]">
      <div className="flex items-center justify-between mb-4 gap-4">
        <h1 className="text-2xl font-semibold text-[var(--color-text-primary)]">Watch Monitor</h1>
        <div className="flex items-center gap-4">
          <PaperAccountBadge />
          <div className="text-sm text-[var(--color-text-muted)]">{activeCount} / 50 active slots</div>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setFilter(f.value)}
            className={`px-3 py-1 text-sm rounded transition-colors ${
              filter === f.value
                ? 'bg-blue-600 text-white'
                : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            {f.label}
          </button>
        ))}
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="ml-auto px-2 py-1 text-sm rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]"
        />
      </div>

      {loading && <div className="text-[var(--color-text-muted)]">Loading…</div>}
      {error && <div className="text-red-400">Error: {error}</div>}
      {!loading && !error && (
        <>
          {(() => {
            // Real P/L uses the paper account's REST-priced unrealized P&L
            // for the open slice (the watch entries' currentPrice is stale,
            // WebSocket-fed) — so it stays in sync with the Unreal badge.
            const { real, whatIf } = pnlBreakdown(entries, account?.unrealizedPnl);
            const fmt = (n: number) =>
              `${n >= 0 ? '+' : ''}₹${Math.abs(n) < 1 ? n.toFixed(2) : n.toFixed(0)}`;
            const colorOf = (n: number) =>
              n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[var(--color-text-secondary)]';
            return (
              <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
                <div>
                  <span className="text-[var(--color-text-muted)]">Real P/L: </span>
                  <span className={`font-semibold tabular-nums ${colorOf(real)}`}>{fmt(real)}</span>
                  <span className="ml-1 text-xs text-[var(--color-text-muted)]">
                    (realized + open positions)
                  </span>
                </div>
                <div
                  title="Hypothetical P/L of alerts that were scored but never actually traded — not real money, never deployed."
                >
                  <span className="text-[var(--color-text-muted)]">What-if (untraded alerts): </span>
                  <span className={`tabular-nums ${colorOf(whatIf)}`}>{fmt(whatIf)}</span>
                </div>
              </div>
            );
          })()}
          <WatchTable entries={entries} onSelect={setSelectedId} selectedId={selectedId} />
        </>
      )}
    </div>
  );
}
