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
  const { selectedSymbol, timeframe } = useChartStore();
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
        { params: { timeframe, from, to } },
      );

      const rawCandles: Candle[] = response.data?.data ?? response.data ?? [];
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
      // Provide demo data so the chart is not empty
      const demoCandles = generateDemoCandles(timeframe);
      setCandles(demoCandles);
      candlesRef.current = demoCandles;
      if (demoCandles.length > 0) {
        const last = demoCandles[demoCandles.length - 1];
        setCurrentPrice(last.close);
        setPriceChange(last.close - demoCandles[0].open);
        setPriceChangePercent(
          ((last.close - demoCandles[0].open) / demoCandles[0].open) * 100,
        );
      }
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

  // Subscribe to WebSocket tick updates
  useEffect(() => {
    const unsub = wsService.subscribe('tick', (data) => {
      const quote = data as Quote;
      if (quote.symbol !== selectedSymbol.symbol) return;

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

    return unsub;
  }, [selectedSymbol.symbol]);

  return { candles, oiData, isLoading, error, currentPrice, priceChange, priceChangePercent };
}

// Generate realistic demo candle data when API is unavailable
function generateDemoCandles(timeframe: string): ChartCandle[] {
  const count = 200;
  const tfMs = getTimeframeDurationMs(timeframe);
  const now = Math.floor(Date.now() / 1000);
  const tfSec = tfMs / 1000;
  const startTime = now - count * tfSec;

  let price = 22500; // Starting around NIFTY levels
  const candles: ChartCandle[] = [];

  for (let i = 0; i < count; i++) {
    const volatility = price * 0.003;
    const change = (Math.random() - 0.48) * volatility;
    const open = price;
    const close = open + change;
    const high = Math.max(open, close) + Math.random() * volatility * 0.5;
    const low = Math.min(open, close) - Math.random() * volatility * 0.5;
    const volume = Math.floor(100000 + Math.random() * 500000);

    candles.push({
      time: startTime + i * tfSec,
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume,
    });

    price = close;
  }

  return candles;
}
