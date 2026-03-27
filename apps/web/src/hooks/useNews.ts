import { useEffect, useRef } from 'react';
import {
  useNewsStore,
  selectSentimentCounts,
  selectTrendingSymbols,
  selectSources,
} from '@/stores/news-store';
import { wsService } from '@/services/websocket';
import type { NewsItem } from '@/types';

const REFRESH_INTERVAL = 60_000; // 1 minute

export function useNews() {
  const fetchNews = useNewsStore((s) => s.fetchNews);
  const addArticle = useNewsStore((s) => s.addArticle);
  const refreshNews = useNewsStore((s) => s.refreshNews);
  const loadMore = useNewsStore((s) => s.loadMore);
  const updateFilters = useNewsStore((s) => s.updateFilters);
  const articles = useNewsStore((s) => s.articles);
  const filters = useNewsStore((s) => s.filters);
  const isLoading = useNewsStore((s) => s.isLoading);
  const isRefreshing = useNewsStore((s) => s.isRefreshing);
  const total = useNewsStore((s) => s.total);
  const lastUpdated = useNewsStore((s) => s.lastUpdated);
  const sentimentCounts = useNewsStore(selectSentimentCounts);
  const trendingSymbols = useNewsStore(selectTrendingSymbols);
  const sources = useNewsStore(selectSources);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchNews(1);

    // Auto-refresh
    intervalRef.current = setInterval(() => fetchNews(1), REFRESH_INTERVAL);

    // WebSocket subscription for real-time news
    const unsub = wsService.subscribe('news', (data) => {
      const payload = data as { type?: string; article?: NewsItem };
      if (payload.article) {
        addArticle(payload.article);
      }
    });

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      unsub();
    };
  }, [fetchNews, addArticle]);

  return {
    articles,
    filters,
    isLoading,
    isRefreshing,
    total,
    lastUpdated,
    sentimentCounts,
    trendingSymbols,
    sources,
    fetchNews,
    refreshNews,
    loadMore,
    updateFilters,
  };
}
