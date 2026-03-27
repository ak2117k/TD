import { useState, useMemo, useCallback } from 'react';
import { BookOpen, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import { DataTable, Badge, PnLDisplay, EmptyState, LoadingSkeleton } from '@/components/common';
import type { Column } from '@/components/common';
import TradeFilters from '@/components/trading/TradeFilters';
import TradeStats from '@/components/trading/TradeStats';
import TradeDetailModal from '@/components/trading/TradeDetailModal';
import StrategyBadge from '@/components/trading/StrategyBadge';
import { useTradeJournal } from '@/hooks/useTradeJournal';
import type { Trade } from '@/types';

function formatDate(d: Date | string | undefined): string {
  if (!d) return '--';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  });
}

function formatTime(d: Date | string | undefined): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function computeDuration(
  start: Date | string | undefined,
  end: Date | string | undefined,
): string {
  if (!start) return '--';
  const s = typeof start === 'string' ? new Date(start) : start;
  const e = end ? (typeof end === 'string' ? new Date(end) : end) : new Date();
  const diff = e.getTime() - s.getTime();
  if (diff < 0) return '--';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  if (hrs < 24) return `${hrs}h ${remMin}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

function statusVariant(
  status: string,
): 'success' | 'danger' | 'warning' | 'info' | 'neutral' {
  switch (status) {
    case 'OPEN':
    case 'PARTIALLY_FILLED':
      return 'info';
    case 'FILLED':
    case 'CLOSED':
      return 'success';
    case 'CANCELLED':
      return 'warning';
    case 'REJECTED':
      return 'danger';
    default:
      return 'neutral';
  }
}

const STRATEGIES = ['rsi-reversal', 'ema-crossover', 'vwap-deviation', 'breakout', 'momentum'];

export default function JournalPage() {
  const {
    trades,
    totalCount,
    isLoading,
    page,
    setPage,
    filters,
    setFilters,
    pageSize,
    refetch,
  } = useTradeJournal();

  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const handleRowClick = useCallback((row: Record<string, unknown>) => {
    setSelectedTrade(row as unknown as Trade);
    setModalOpen(true);
  }, []);

  const handleExportCSV = useCallback(() => {
    if (trades.length === 0) return;
    const headers = [
      'Date', 'Symbol', 'Side', 'Entry', 'Exit', 'Qty', 'P&L', 'P&L%',
      'Strategy', 'Type', 'Status', 'Duration',
    ];
    const rows = trades.map((t) => [
      formatDate(t.createdAt),
      t.symbol,
      t.side,
      t.entryPrice,
      t.exitPrice ?? '',
      t.quantity,
      t.pnl,
      t.pnlPercent,
      t.strategy,
      t.isPaper ? 'Paper' : 'Live',
      t.status,
      computeDuration(t.createdAt, t.closedAt),
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trade-journal-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [trades]);

  const columns: Column<Record<string, unknown>>[] = useMemo(
    () => [
      {
        key: 'createdAt',
        header: 'Date',
        sortable: true,
        width: '110px',
        render: (_val, row) => {
          const t = row as unknown as Trade;
          return (
            <div>
              <div className="text-xs text-gray-200">{formatDate(t.createdAt)}</div>
              <div className="text-[10px] text-gray-500">{formatTime(t.createdAt)}</div>
            </div>
          );
        },
      },
      {
        key: 'symbol',
        header: 'Symbol',
        sortable: true,
        render: (_val, row) => {
          const t = row as unknown as Trade;
          return (
            <div>
              <span className="text-xs font-medium text-gray-100">{t.symbol}</span>
              <span className="ml-1 text-[10px] text-gray-500">{t.exchange}</span>
            </div>
          );
        },
      },
      {
        key: 'side',
        header: 'Side',
        width: '60px',
        render: (_val, row) => {
          const t = row as unknown as Trade;
          return (
            <Badge
              label={t.side}
              variant={t.side === 'BUY' ? 'success' : 'danger'}
              size="sm"
            />
          );
        },
      },
      {
        key: 'entryPrice',
        header: 'Entry',
        align: 'right' as const,
        sortable: true,
        render: (_val, row) => {
          const t = row as unknown as Trade;
          return <span className="text-xs">{t.entryPrice.toFixed(2)}</span>;
        },
      },
      {
        key: 'exitPrice',
        header: 'Exit',
        align: 'right' as const,
        render: (_val, row) => {
          const t = row as unknown as Trade;
          return (
            <span className="text-xs">
              {t.exitPrice ? t.exitPrice.toFixed(2) : '--'}
            </span>
          );
        },
      },
      {
        key: 'quantity',
        header: 'Qty',
        align: 'right' as const,
        width: '60px',
        render: (_val, row) => {
          const t = row as unknown as Trade;
          return <span className="text-xs">{t.quantity}</span>;
        },
      },
      {
        key: 'pnl',
        header: 'P&L',
        align: 'right' as const,
        sortable: true,
        render: (_val, row) => {
          const t = row as unknown as Trade;
          return <PnLDisplay value={t.pnl} size="sm" />;
        },
      },
      {
        key: 'pnlPercent',
        header: 'P&L%',
        align: 'right' as const,
        sortable: true,
        width: '70px',
        render: (_val, row) => {
          const t = row as unknown as Trade;
          const color =
            t.pnlPercent > 0
              ? 'text-emerald-400'
              : t.pnlPercent < 0
                ? 'text-red-400'
                : 'text-gray-400';
          return (
            <span className={`text-xs ${color}`}>
              {t.pnlPercent >= 0 ? '+' : ''}
              {t.pnlPercent.toFixed(2)}%
            </span>
          );
        },
      },
      {
        key: 'strategy',
        header: 'Strategy',
        render: (_val, row) => {
          const t = row as unknown as Trade;
          return t.strategy ? (
            <StrategyBadge strategy={t.strategy} />
          ) : (
            <span className="text-xs text-gray-500">--</span>
          );
        },
      },
      {
        key: 'isPaper',
        header: 'Type',
        width: '65px',
        render: (_val, row) => {
          const t = row as unknown as Trade;
          return (
            <Badge
              label={t.isPaper ? 'Paper' : 'Live'}
              variant={t.isPaper ? 'warning' : 'info'}
              size="sm"
            />
          );
        },
      },
      {
        key: 'status',
        header: 'Status',
        width: '80px',
        render: (_val, row) => {
          const t = row as unknown as Trade;
          return <Badge label={t.status} variant={statusVariant(t.status)} size="sm" />;
        },
      },
      {
        key: 'duration',
        header: 'Duration',
        width: '80px',
        render: (_val, row) => {
          const t = row as unknown as Trade;
          return (
            <span className="text-xs text-gray-400">
              {computeDuration(t.createdAt, t.closedAt)}
            </span>
          );
        },
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BookOpen size={24} className="text-[var(--color-accent-blue)]" />
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            Trade Journal
          </h1>
          {totalCount > 0 && (
            <span className="text-xs text-gray-500 mt-1">
              {totalCount} trade{totalCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <button
          onClick={handleExportCSV}
          disabled={trades.length === 0}
          className="flex items-center gap-1.5 rounded-md border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Download size={14} />
          Export CSV
        </button>
      </div>

      {/* Stats */}
      {!isLoading && trades.length > 0 && <TradeStats trades={trades} />}

      {/* Filters */}
      <TradeFilters
        filters={filters}
        onFilterChange={setFilters}
        strategies={STRATEGIES}
      />

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          <LoadingSkeleton variant="table-row" count={8} />
        </div>
      ) : trades.length === 0 ? (
        <EmptyState
          icon={<BookOpen size={48} />}
          title="No trades yet"
          description="Start trading to see your history here."
        />
      ) : (
        <>
          <DataTable
            columns={columns}
            data={trades as unknown as Record<string, unknown>[]}
            onRowClick={handleRowClick}
            sortable
          />

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <span className="text-xs text-gray-500">
                Page {page} of {totalPages} ({totalCount} total)
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(page - 1)}
                  disabled={page <= 1}
                  className="rounded-md border border-gray-700 bg-gray-800 p-1.5 text-gray-400 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft size={14} />
                </button>
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNum: number;
                  if (totalPages <= 5) {
                    pageNum = i + 1;
                  } else if (page <= 3) {
                    pageNum = i + 1;
                  } else if (page >= totalPages - 2) {
                    pageNum = totalPages - 4 + i;
                  } else {
                    pageNum = page - 2 + i;
                  }
                  return (
                    <button
                      key={pageNum}
                      onClick={() => setPage(pageNum)}
                      className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                        pageNum === page
                          ? 'border-blue-500 bg-blue-600/20 text-blue-400'
                          : 'border-gray-700 bg-gray-800 text-gray-400 hover:bg-gray-700'
                      }`}
                    >
                      {pageNum}
                    </button>
                  );
                })}
                <button
                  onClick={() => setPage(page + 1)}
                  disabled={page >= totalPages}
                  className="rounded-md border border-gray-700 bg-gray-800 p-1.5 text-gray-400 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Trade Detail Modal */}
      <TradeDetailModal
        trade={selectedTrade}
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onTradeUpdated={refetch}
      />
    </div>
  );
}
