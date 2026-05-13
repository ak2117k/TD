import { useEffect, useState } from 'react';
import { watchApi } from '../../services/watch.service';
import type { WatchEntryWithEvents } from '../../types/watch.types';
import { WatchEventLog } from './WatchEventLog';

interface Props { entryId: string }

export function WatchDetailPanel({ entryId }: Props) {
  const [entry, setEntry] = useState<WatchEntryWithEvents | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const data = await watchApi.get(entryId);
      setEntry(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => { refresh(); }, [entryId]);

  async function execute(mode: 'paper' | 'live') {
    setBusy(true);
    setError(null);
    try { await watchApi.execute(entryId, mode); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function dismiss() {
    setBusy(true);
    try { await watchApi.dismiss(entryId); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (!entry) return <div className="p-4 text-gray-500">{error ? `Error: ${error}` : 'Loading…'}</div>;

  return (
    <div className="p-4 bg-white border rounded">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <span className="font-mono text-lg">{entry.symbol}</span>
          <span className="ml-2 text-gray-600">{entry.side}</span>
          <span className={`ml-2 px-2 py-0.5 rounded text-xs ${entry.status === 'WATCHING' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-700'}`}>
            {entry.status}
          </span>
        </div>
        <div className="text-xs text-gray-500">{new Date(entry.initialAt).toLocaleString('en-IN')}</div>
      </div>

      <div className="grid grid-cols-3 gap-3 text-sm mb-4">
        <div><div className="text-gray-500 text-xs">Initial</div><div>₹{entry.initialPrice.toFixed(2)} (score {entry.initialScore})</div></div>
        <div><div className="text-gray-500 text-xs">Current</div><div>₹{(entry.currentPrice ?? entry.initialPrice).toFixed(2)} (score {entry.currentScore ?? entry.initialScore})</div></div>
        <div><div className="text-gray-500 text-xs">Target</div><div>₹{entry.profitTarget.toFixed(2)} ({entry.profitTargetSource})</div></div>
        <div><div className="text-gray-500 text-xs">Max Favorable</div><div>₹{entry.maxFavorable?.toFixed(2) ?? '—'}</div></div>
        <div><div className="text-gray-500 text-xs">Max Adverse</div><div>₹{entry.maxAdverse?.toFixed(2) ?? '—'}</div></div>
        <div><div className="text-gray-500 text-xs">SL (score)</div><div>&lt; {entry.stopLossScore}</div></div>
      </div>

      {entry.optionsToken && (
        <div className="text-sm mb-4 p-2 bg-gray-50 rounded">
          <div className="text-xs text-gray-500 mb-1">Options leg</div>
          <div className="font-mono">
            {entry.symbol} {entry.optionsStrike} {entry.optionsType}
            {entry.optionsExpiry && <> · expires {new Date(entry.optionsExpiry).toLocaleDateString('en-IN')}</>}
            {entry.optionsSelectionScore != null && <> · rank-score {entry.optionsSelectionScore.toFixed(3)}</>}
          </div>
        </div>
      )}

      <div className="mb-4">
        <div className="text-xs text-gray-500 mb-2">Event log</div>
        <WatchEventLog events={entry.events} />
      </div>

      {entry.status === 'WATCHING' && (
        <div className="flex gap-2">
          <button onClick={() => execute('paper')} disabled={busy}
            className="px-3 py-1 bg-blue-600 text-white text-sm rounded disabled:opacity-50">
            Execute Paper
          </button>
          <button onClick={() => execute('live')} disabled={busy}
            className="px-3 py-1 bg-emerald-600 text-white text-sm rounded disabled:opacity-50">
            Execute Live
          </button>
          <button onClick={dismiss} disabled={busy}
            className="px-3 py-1 bg-gray-200 text-gray-700 text-sm rounded disabled:opacity-50">
            Dismiss
          </button>
        </div>
      )}
      {error && <div className="mt-2 text-sm text-red-600">{error}</div>}
    </div>
  );
}
