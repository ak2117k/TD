import { useState } from 'react';
import { useWatchEntries } from '../../hooks/useWatchEntries';
import { WatchTable } from './WatchTable';
import { WatchDetailPanel } from './WatchDetailPanel';
import type { WatchStatus } from '../../types/watch.types';

const FILTERS: Array<{ label: string; value: WatchStatus | undefined }> = [
  { label: 'All', value: undefined },
  { label: 'Watching', value: 'WATCHING' },
  { label: 'Traded', value: 'TRADED' },
  { label: 'Stopped', value: 'STOPPED' },
  { label: 'Target Hit', value: 'TARGET_HIT' },
];

export function WatchPage() {
  const [filter, setFilter] = useState<WatchStatus | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { entries, loading, error } = useWatchEntries(filter);
  const activeCount = entries.filter(e => e.status === 'WATCHING' || e.status === 'TRADED').length;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Watch Monitor</h1>
        <div className="text-sm text-gray-500">{activeCount} / 50 active slots</div>
      </div>

      <div className="flex gap-2 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setFilter(f.value)}
            className={`px-3 py-1 text-sm rounded ${filter === f.value
              ? 'bg-blue-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && <div className="text-gray-500">Loading…</div>}
      {error && <div className="text-red-600">Error: {error}</div>}
      {!loading && !error && (
        <div className="grid grid-cols-3 gap-4">
          <div className="col-span-2">
            <WatchTable entries={entries} onSelect={setSelectedId} selectedId={selectedId} />
          </div>
          <div className="col-span-1">
            {selectedId
              ? <WatchDetailPanel entryId={selectedId} />
              : <div className="p-6 text-gray-400 text-sm">Select a row to see details.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
