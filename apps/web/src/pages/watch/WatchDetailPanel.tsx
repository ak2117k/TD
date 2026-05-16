import { useEffect, useState } from 'react';
import { watchApi } from '../../services/watch.service';
import type { WatchEntryWithEvents } from '../../types/watch.types';
import { WatchEventLog } from './WatchEventLog';

interface Props { entryId: string; onClose?: () => void }

export function WatchDetailPanel({ entryId, onClose }: Props) {
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

  if (!entry) {
    return (
      <div className="p-4 flex items-start justify-between text-[var(--color-text-muted)]">
        <span>{error ? `Error: ${error}` : 'Loading…'}</span>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] text-xl leading-none px-1"
          >
            ×
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 bg-[var(--color-bg-secondary)] border border-[var(--color-border-subtle)] rounded text-[var(--color-text-primary)]">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <span className="font-mono text-lg text-[var(--color-text-primary)]">{entry.symbol}</span>
          <span className="ml-2 text-[var(--color-text-secondary)]">{entry.side}</span>
          <span
            className={`ml-2 px-2 py-0.5 rounded text-xs font-medium ${
              entry.status === 'WATCHING'
                ? 'bg-blue-500/20 text-blue-300'
                : entry.status === 'TRADED'
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : entry.status === 'TARGET_HIT'
                    ? 'bg-emerald-600/30 text-emerald-200'
                    : entry.status === 'STOPPED'
                      ? 'bg-red-500/20 text-red-300'
                      : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]'
            }`}
          >
            {entry.status}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-[var(--color-text-muted)]">
            {new Date(entry.initialAt).toLocaleString('en-IN')}
          </span>
          {onClose && (
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] text-xl leading-none px-1"
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 text-sm mb-4">
        <div>
          <div className="text-[var(--color-text-muted)] text-xs">Initial</div>
          <div className="text-[var(--color-text-primary)]">
            ₹{entry.initialPrice.toFixed(2)} (score {entry.initialScore})
          </div>
        </div>
        <div>
          <div className="text-[var(--color-text-muted)] text-xs">Current</div>
          <div className="text-[var(--color-text-primary)]">
            ₹{(entry.currentPrice ?? entry.initialPrice).toFixed(2)} (score {entry.currentScore ?? entry.initialScore})
          </div>
        </div>
        <div>
          <div className="text-[var(--color-text-muted)] text-xs">Target</div>
          <div className="text-[var(--color-text-primary)]">
            ₹{entry.profitTarget.toFixed(2)} <span className="text-[var(--color-text-muted)] text-xs">({entry.profitTargetSource})</span>
          </div>
        </div>
        <div>
          <div className="text-[var(--color-text-muted)] text-xs">Max Favorable</div>
          <div className="text-[var(--color-text-primary)]">₹{entry.maxFavorable?.toFixed(2) ?? '—'}</div>
        </div>
        <div>
          <div className="text-[var(--color-text-muted)] text-xs">Max Adverse</div>
          <div className="text-[var(--color-text-primary)]">₹{entry.maxAdverse?.toFixed(2) ?? '—'}</div>
        </div>
        <div>
          <div className="text-[var(--color-text-muted)] text-xs">SL (score)</div>
          <div className="text-[var(--color-text-primary)]">&lt; {entry.stopLossScore}</div>
        </div>
      </div>

      {entry.optionsToken && (
        <div className="text-sm mb-4 p-2 bg-[var(--color-bg-tertiary)] rounded">
          <div className="text-xs text-[var(--color-text-muted)] mb-1">Options leg</div>
          <div className="font-mono text-[var(--color-text-primary)]">
            {entry.symbol} {entry.optionsStrike} {entry.optionsType}
            {entry.optionsExpiry && (
              <> · expires {new Date(entry.optionsExpiry).toLocaleDateString('en-IN')}</>
            )}
            {entry.optionsSelectionScore != null && (
              <> · rank-score {entry.optionsSelectionScore.toFixed(3)}</>
            )}
          </div>
        </div>
      )}

      <div className="mb-4">
        <div className="text-xs text-[var(--color-text-muted)] mb-2">Event log</div>
        <WatchEventLog events={entry.events} />
      </div>

      {entry.status === 'WATCHING' && (
        <div className="flex gap-2">
          <button
            onClick={() => execute('paper')}
            disabled={busy}
            className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-500 transition-colors disabled:opacity-50"
          >
            Execute Paper
          </button>
          <button
            onClick={() => execute('live')}
            disabled={busy}
            className="px-3 py-1 bg-emerald-600 text-white text-sm rounded hover:bg-emerald-500 transition-colors disabled:opacity-50"
          >
            Execute Live
          </button>
          <button
            onClick={dismiss}
            disabled={busy}
            className="px-3 py-1 bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] text-sm rounded hover:bg-[var(--color-bg-tertiary)]/70 transition-colors disabled:opacity-50"
          >
            Dismiss
          </button>
        </div>
      )}
      {error && <div className="mt-2 text-sm text-red-400">{error}</div>}
    </div>
  );
}
