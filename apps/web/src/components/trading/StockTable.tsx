import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMarketStore } from '@/stores/market-store';
import type { Quote } from '@/types';
import PriceCell from './PriceCell';

type SortField = 'symbol' | 'ltp' | 'change' | 'changePercent' | 'open' | 'high' | 'low' | 'volume';
type SortDir = 'asc' | 'desc';

interface StockTableProps {
  filter: string;
  exchangeFilter?: string;
  watchlistSymbols?: string[];
}

const PAGE_SIZE = 25;

export default function StockTable({ filter, exchangeFilter, watchlistSymbols }: StockTableProps) {
  const quotes = useMarketStore((s) => s.quotes);
  const navigate = useNavigate();
  const [sortField, setSortField] = useState<SortField>('symbol');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(0);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir(field === 'symbol' ? 'asc' : 'desc');
    }
  };

  const filtered = useMemo(() => {
    let list = Array.from(quotes.values()) as Quote[];

    if (filter) {
      const lc = filter.toLowerCase();
      list = list.filter((q) => q.symbol.toLowerCase().includes(lc));
    }
    if (exchangeFilter && exchangeFilter !== 'ALL') {
      list = list.filter((q) => q.exchange === exchangeFilter);
    }
    if (watchlistSymbols) {
      const set = new Set(watchlistSymbols);
      list = list.filter((q) => set.has(q.symbol));
    }

    list.sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      const diff = (aVal as number) - (bVal as number);
      return sortDir === 'asc' ? diff : -diff;
    });

    return list;
  }, [quotes, filter, exchangeFilter, watchlistSymbols, sortField, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const SortHeader = ({ field, label, className }: { field: SortField; label: string; className?: string }) => (
    <th
      onClick={() => handleSort(field)}
      className={`cursor-pointer select-none whitespace-nowrap px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] ${className ?? ''}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <ArrowUpDown size={10} className={sortField === field ? 'text-[var(--color-accent-blue)]' : 'opacity-40'} />
      </span>
    </th>
  );

  return (
    <div className="flex flex-col">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border-subtle)]">
              <SortHeader field="symbol" label="Symbol" className="!text-left" />
              <SortHeader field="ltp" label="LTP" />
              <SortHeader field="change" label="Change" />
              <SortHeader field="changePercent" label="Chg%" />
              <SortHeader field="open" label="Open" />
              <SortHeader field="high" label="High" />
              <SortHeader field="low" label="Low" />
              <SortHeader field="volume" label="Volume" />
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-8 text-center text-[var(--color-text-muted)]">
                  {quotes.size === 0 ? 'Waiting for market data...' : 'No matching instruments'}
                </td>
              </tr>
            ) : (
              paged.map((q) => {
                const isPos = q.change >= 0;
                return (
                  <tr
                    key={`${q.exchange}-${q.symbol}`}
                    onClick={() => navigate(`/charts?symbol=${q.symbol}&exchange=${q.exchange}`)}
                    className="cursor-pointer border-b border-[var(--color-border-subtle)]/50 transition-colors hover:bg-[var(--color-bg-tertiary)]"
                  >
                    <td className="whitespace-nowrap px-3 py-2 text-left font-medium text-[var(--color-text-primary)]">
                      <div className="flex flex-col">
                        <span>{q.symbol}</span>
                        <span className="text-[10px] text-[var(--color-text-muted)]">{q.exchange}</span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[var(--color-text-primary)]">
                      <PriceCell price={q.ltp} />
                    </td>
                    <td className={`whitespace-nowrap px-3 py-2 text-right font-mono ${isPos ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]'}`}>
                      {isPos ? '+' : ''}{q.change.toFixed(2)}
                    </td>
                    <td className={`whitespace-nowrap px-3 py-2 text-right font-mono ${isPos ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]'}`}>
                      {isPos ? '+' : ''}{q.changePercent.toFixed(2)}%
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[var(--color-text-secondary)]">
                      {q.open.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[var(--color-text-secondary)]">
                      {q.high.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[var(--color-text-secondary)]">
                      {q.low.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[var(--color-text-secondary)]">
                      {q.volume.toLocaleString('en-IN')}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] px-3 py-2">
          <span className="text-xs text-[var(--color-text-muted)]">
            {filtered.length} instruments | Page {page + 1} of {totalPages}
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-30"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-30"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
