import { useState } from 'react';
import { useWatchEntries } from '../../hooks/useWatchEntries';
import { WatchTable } from './WatchTable';
import { PaperAccountBadge } from '../../components/trading/PaperAccountBadge';
import { sectionTotalPnl } from '../../utils/watchPnl';
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
            const total = sectionTotalPnl(entries);
            return (
              <div className="mb-3 text-sm">
                <span className="text-[var(--color-text-muted)]">
                  {'Total P/L (incl. what-if): '}
                </span>
                <span className={`font-semibold tabular-nums ${
                  total > 0 ? 'text-emerald-400' : total < 0 ? 'text-red-400' : 'text-[var(--color-text-secondary)]'
                }`}>
                  {total >= 0 ? '+' : ''}₹{Math.abs(total) < 1 ? total.toFixed(2) : total.toFixed(0)}
                </span>
              </div>
            );
          })()}
          <WatchTable entries={entries} onSelect={setSelectedId} selectedId={selectedId} />
        </>
      )}
    </div>
  );
}
