import type { WatchEntry } from '../../types/watch.types';

interface Props {
  entries: WatchEntry[];
  onSelect: (id: string) => void;
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
          <th className="py-2 px-3 text-right">Target</th>
          <th className="py-2 px-3 text-left">Status</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr
            key={e.id}
            onClick={() => onSelect(e.id)}
            className={`border-b border-[var(--color-border-subtle)] cursor-pointer transition-colors ${
              e.id === selectedId
                ? 'bg-[var(--color-bg-tertiary)]'
                : 'hover:bg-[var(--color-bg-tertiary)]/50'
            }`}
          >
            <td className="py-2 px-3 font-mono text-[var(--color-text-primary)]">{e.symbol}</td>
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
            <td className="py-2 px-3 text-right text-[var(--color-text-secondary)]">
              {e.profitTarget.toFixed(2)}
            </td>
            <td className={`py-2 px-3 font-medium ${statusColor(e.status)}`}>{e.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
