import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api';
import type { Trade } from '@/types';

export interface JournalFilters {
  dateFrom: string;
  dateTo: string;
  status: string;
  strategy: string;
  segment: string;
  paperLive: string;
  sortBy: string;
  // M5: filter by the regime/exit-reason fields captured at entry/exit.
  // 'all' is treated as "no filter" — same convention as status/strategy.
  vixRegime: string;
  exitReasonTag: string;
}

const defaultFilters: JournalFilters = {
  dateFrom: '',
  dateTo: '',
  status: 'all',
  strategy: 'all',
  segment: 'all',
  paperLive: 'all',
  sortBy: 'date',
  vixRegime: 'all',
  exitReasonTag: 'all',
};

const PAGE_SIZE = 20;

export function useTradeJournal() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<JournalFilters>(defaultFilters);

  const fetchTrades = useCallback(async () => {
    setIsLoading(true);
    try {
      const params: Record<string, string | number> = {
        page,
        limit: PAGE_SIZE,
      };
      if (filters.dateFrom) params.dateFrom = filters.dateFrom;
      if (filters.dateTo) params.dateTo = filters.dateTo;
      if (filters.status !== 'all') params.status = filters.status;
      if (filters.strategy !== 'all') params.strategy = filters.strategy;
      if (filters.segment !== 'all') params.segment = filters.segment;
      if (filters.paperLive !== 'all') params.paperLive = filters.paperLive;
      if (filters.sortBy) params.sortBy = filters.sortBy;
      if (filters.vixRegime && filters.vixRegime !== 'all') {
        params.vixRegime = filters.vixRegime;
      }
      if (filters.exitReasonTag && filters.exitReasonTag !== 'all') {
        params.exitReasonTag = filters.exitReasonTag;
      }

      const { data } = await api.get('/portfolio/journal', { params });
      // Backend trade rows use `isPaperTrade` but the frontend Trade type
      // and every consumer (TradeCard, JournalPage, TradeDetailModal) reads
      // `isPaper`. Normalize at the fetch site so the rest of the page
      // never has to know about the field-name divergence.
      const raw: any[] = data.trades ?? data.data ?? [];
      setTrades(
        raw.map((t) => ({
          ...t,
          isPaper: t.isPaper ?? t.isPaperTrade ?? false,
          symbol: t.symbol ?? t.instrument?.symbol ?? '',
          exchange: t.exchange ?? t.instrument?.exchange ?? '',
        })),
      );
      setTotalCount(data.totalCount ?? data.total ?? 0);
    } catch {
      console.warn('Failed to fetch trade journal');
      setTrades([]);
      setTotalCount(0);
    } finally {
      setIsLoading(false);
    }
  }, [page, filters]);

  useEffect(() => {
    fetchTrades();
  }, [fetchTrades]);

  const updateFilters = useCallback(
    (partial: Partial<JournalFilters>) => {
      setFilters((prev) => ({ ...prev, ...partial }));
      setPage(1);
    },
    [],
  );

  return {
    trades,
    totalCount,
    isLoading,
    page,
    setPage,
    filters,
    setFilters: updateFilters,
    pageSize: PAGE_SIZE,
    refetch: fetchTrades,
  };
}
