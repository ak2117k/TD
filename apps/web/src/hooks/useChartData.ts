import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api';
import { wsService } from '@/services/websocket';
import { useChartStore } from '@/stores/chart-store';
import type { Candle, OIData, Quote } from '@/types';

interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ChartOIData {
  time: number;
  value: number;
}

interface UseChartDataReturn {
  candles: ChartCandle[];
  oiData: ChartOIData[];
  isLoading: boolean;
  error: string | null;
  currentPrice: number | null;
  priceChange: number | null;
  priceChangePercent: number | null;
}

function getTimeframeDurationMs(timeframe: string): number {
  const map: Record<string, number> = {
    '1m': 60_000,
    '5m': 5 * 60_000,
    '15m': 15 * 60_000,
    '30m': 30 * 60_000,
    '1h': 60 * 60_000,
    '4h': 4 * 60 * 60_000,
    '1d': 24 * 60 * 60_000,
    '1w': 7 * 24 * 60 * 60_000,
  };
  return map[timeframe] ?? 15 * 60_000;
}

function getHistoryRangeDays(timeframe: string): number {
  const map: Record<string, number> = {
    '1m': 2,
    '5m': 5,
    '15m': 15,
    '30m': 30,
    '1h': 60,
    '4h': 120,
    '1d': 365,
    '1w': 730,
  };
  return map[timeframe] ?? 15;
}

function candleToChart(c: Candle): ChartCandle {
  const ts = new Date(c.timestamp).getTime() / 1000;
  return {
    time: ts,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  };
}

export function useChartData(): UseChartDataReturn {
  const selectedSymbol = useChartStore((s) => s.selectedSymbol);
  const timeframe = useChartStore((s) => s.timeframe);
  const [candles, setCandles] = useState<ChartCandle[]>([]);
  const [oiData, setOiData] = useState<ChartOIData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [priceChange, setPriceChange] = useState<number | null>(null);
  const [priceChangePercent, setPriceChangePercent] = useState<number | null>(null);
  const candlesRef = useRef<ChartCandle[]>([]);
  const timeframeMsRef = useRef(getTimeframeDurationMs(timeframe));

  // Fetch historical candles
  const fetchCandles = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const days = getHistoryRangeDays(timeframe);
      const to = new Date().toISOString();
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const response = await api.get(
        `/market-data/instruments/${selectedSymbol.token}/candles`,
        { params: { timeframe, from, to, exchange: selectedSymbol.exchange } },
      );

      const rawCandles: Candle[] = response.data?.candles ?? response.data?.data ?? [];
      const chartCandles = rawCandles
        .map(candleToChart)
        .sort((a, b) => a.time - b.time);

      // Deduplicate by time
      const seen = new Set<number>();
      const deduped = chartCandles.filter((c) => {
        if (seen.has(c.time)) return false;
        seen.add(c.time);
        return true;
      });

      setCandles(deduped);
      candlesRef.current = deduped;

      if (deduped.length > 0) {
        const last = deduped[deduped.length - 1];
        setCurrentPrice(last.close);
        if (deduped.length > 1) {
          const prev = deduped[0];
          setPriceChange(last.close - prev.open);
          setPriceChangePercent(((last.close - prev.open) / prev.open) * 100);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch candles';
      setError(msg);
      setCandles([]);
      candlesRef.current = [];
    } finally {
      setIsLoading(false);
    }
  }, [selectedSymbol.token, timeframe]);

  // Fetch OI data
  const fetchOI = useCallback(async () => {
    try {
      const response = await api.get(
        `/market-data/instruments/${selectedSymbol.token}/oi`,
      );
      const rawOI: OIData[] = response.data?.data ?? response.data ?? [];
      setOiData(
        rawOI.map((o) => ({
          time: new Date(o.timestamp).getTime() / 1000,
          value: o.oi,
        })),
      );
    } catch {
      // OI data is optional, fail silently
    }
  }, [selectedSymbol.token]);

  useEffect(() => {
    timeframeMsRef.current = getTimeframeDurationMs(timeframe);
    fetchCandles();
    fetchOI();
  }, [fetchCandles, fetchOI, timeframe]);

  // Subscribe to WebSocket tick updates for real-time candle building
  useEffect(() => {
    const unsubTick = wsService.subscribe('tick', (data) => {
      const quote = data as Quote;
      // Filter by token (reliable unique identifier) instead of symbol name
      // which can vary between data sources (WebSocket vs REST, broker formats)
      if (quote.token !== selectedSymbol.token) return;

      const price = quote.ltp;
      setCurrentPrice(price);
      setPriceChange(quote.change);
      setPriceChangePercent(quote.changePercent);

      setCandles((prev) => {
        if (prev.length === 0) return prev;

        const tickTime = new Date(quote.timestamp).getTime() / 1000;
        const tfSec = timeframeMsRef.current / 1000;
        const candleTime = Math.floor(tickTime / tfSec) * tfSec;

        const last = prev[prev.length - 1];

        if (last.time === candleTime) {
          // Update existing candle
          const updated: ChartCandle = {
            ...last,
            high: Math.max(last.high, price),
            low: Math.min(last.low, price),
            close: price,
            volume: last.volume + (quote.volume ?? 0),
          };
          const next = [...prev.slice(0, -1), updated];
          candlesRef.current = next;
          return next;
        } else if (candleTime > last.time) {
          // New candle
          const newCandle: ChartCandle = {
            time: candleTime,
            open: price,
            high: price,
            low: price,
            close: price,
            volume: quote.volume ?? 0,
          };
          const next = [...prev, newCandle];
          candlesRef.current = next;
          return next;
        }

        return prev;
      });
    });

    // Subscribe to server-side closed candle events (emitted by CandleAggregator)
    const unsubCandle = wsService.subscribe('candle', (data) => {
      const candle = data as {
        token: string;
        timeframe: string;
        timestamp: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      };
      if (candle.token !== selectedSymbol.token) return;
      if (candle.timeframe !== timeframe) return;

      const chartCandle: ChartCandle = {
        time: new Date(candle.timestamp).getTime() / 1000,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      };

      setCandles((prev) => {
        // Replace if same timestamp, or append if new
        const existing = prev.findIndex((c) => c.time === chartCandle.time);
        if (existing >= 0) {
          const next = [...prev];
          next[existing] = chartCandle;
          candlesRef.current = next;
          return next;
        }
        if (prev.length === 0 || chartCandle.time > prev[prev.length - 1].time) {
          const next = [...prev, chartCandle];
          candlesRef.current = next;
          return next;
        }
        return prev;
      });
    });

    return () => {
      unsubTick();
      unsubCandle();
    };
  }, [selectedSymbol.symbol, selectedSymbol.token, timeframe]);

  return { candles, oiData, isLoading, error, currentPrice, priceChange, priceChangePercent };
}