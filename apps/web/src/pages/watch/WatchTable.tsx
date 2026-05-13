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
    case 'WATCHING': return 'text-blue-600';
    case 'TRADED': return 'text-emerald-600';
    case 'TARGET_HIT': return 'text-emerald-700';
    case 'STOPPED': return 'text-red-600';
    case 'EXITED': return 'text-gray-600';
    case 'DISMISSED': return 'text-gray-400';
    default: return '';
  }
}

export function WatchTable({ entries, onSelect, selectedId }: Props) {
  if (entries.length === 0) {
    return <div className="p-6 text-center text-gray-500">No watch entries.</div>;
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-gray-500 border-b">
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
            className={`border-b hover:bg-gray-50 cursor-pointer ${e.id === selectedId ? 'bg-blue-50' : ''}`}
          >
            <td className="py-2 px-3 font-mono">{e.symbol}</td>
            <td className="py-2 px-3">{e.side}</td>
            <td className="py-2 px-3 text-right">
              {e.initialScore}
              {e.currentScore != null && e.currentScore !== e.initialScore ? <> → <strong>{e.currentScore}</strong></> : null}
            </td>
            <td className="py-2 px-3 text-right">
              {e.currentPrice?.toFixed(2) ?? e.initialPrice.toFixed(2)}
            </td>
            <td className="py-2 px-3 text-right">{pctChange(e.currentPrice, e.initialPrice)}</td>
            <td className="py-2 px-3 text-right">{e.profitTarget.toFixed(2)}</td>
            <td className={`py-2 px-3 ${statusColor(e.status)}`}>{e.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
