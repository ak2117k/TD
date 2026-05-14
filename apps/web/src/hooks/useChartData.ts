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
  // Maps compressed candle times (what's actually plotted) back to the real
  // unix timestamps. Used by CandlestickChart to format axis labels and
  // crosshair tooltips so they show actual market times even though the
  // chart's time axis is gap-collapsed for visual continuity.
  realTimeMap: Map<number, number>;
}

/**
 * Walk the time-sorted candle list and collapse any inter-candle gap that
 * exceeds 2× the timeframe (i.e. anything bigger than a normal "next bar")
 * down to a single timeframe. Result: overnight + weekend + holiday gaps
 * become one-bar visual breaks instead of huge empty stretches that make
 * intraday charts look broken.
 *
 * Returns the remapped candles plus a Map from compressed time → real time
 * so the chart can label axes/crosshairs with the actual market time.
 */
function compressTimes<T extends { time: number }>(
  items: T[],
  tfSec: number,
): { compressed: T[]; realByCompressed: Map<number, number> } {
  const realByCompressed = new Map<number, number>();
  if (items.length === 0) return { compressed: [], realByCompressed };

  const compressed: T[] = [];
  let offset = 0;
  let prevReal = items[0].time;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (i > 0) {
      const gap = item.time - prevReal;
      if (gap > tfSec * 2) {
        // Collapse the oversized gap down to one timeframe.
        offset += gap - tfSec;
      }
    }
    prevReal = item.time;
    const compressedTime = item.time - offset;
    compressed.push({ ...item, time: compressedTime });
    realByCompressed.set(compressedTime, item.time);
  }
  return { compressed, realByCompressed };
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
  // Calendar-day lookback per timeframe. Tuned to match what discretionary
  // traders actually want to see on each TF — too many bars (e.g. 250 bars
  // on a 15m view) compress to sub-pixel widths and the chart looks empty;
  // too few bars (e.g. 1 day on 1h) doesn't give context.
  //
  // Targets: ~60-150 bars per view at default zoom.
  const map: Record<string, number> = {
    '1m': 1,    // ~375 bars during one trading day — already a lot for 1m
    '5m': 2,    // ~150 bars over 2 trading days
    '15m': 5,   // ~125 bars over 5 trading days
    '30m': 10,  // ~130 bars
    '1h': 30,   // ~210 bars
    '4h': 90,   // ~135 bars
    '1d': 365,  // ~250 daily bars in a year
    '1w': 730,
  };
  return map[timeframe] ?? 5;
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
  const [realTimeMap, setRealTimeMap] = useState<Map<number, number>>(new Map());
  // Live-update path needs to know the real-time bucket of the most-recent
  // bar so a new tick can decide "extend last bar" vs "append a new one".
  const lastRealBucketRef = useRef<number>(0);

  // Fetch historical candles
  const fetchCandles = useCallback(async () => {
    // Reset state synchronously BEFORE awaiting the API. The previous
    // symbol's candles must not be visible — and crucially, must not be
    // mutated by incoming live ticks — while this fetch is in flight.
    // Without this, switching from a high-priced symbol (e.g. NIFTY ~24k)
    // to a low-priced one (CRUDEOIL ~9k) produces a hybrid candle:
    // NIFTY's open/high preserved, CRUDEOIL's tick extending close/low.
    setCandles([]);
    candlesRef.current = [];
    lastRealBucketRef.current = 0;
    setRealTimeMap(new Map());

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

      // Drop "ghost" candles that have no real range AND no body movement.
      // We also keep zero-volume candles when they have a real range — index
      // candles (e.g. NIFTY) often have volume=0 by design.
      const meaningful = deduped.filter((c) => {
        const noRange = c.high === c.low;
        const noBody = c.open === c.close;
        if (noRange && noBody) return false;
        // Sanity guard: drop any candle with zero/negative prices (occasional
        // bad-data artifact; would skew the price scale).
        if (c.open <= 0 || c.close <= 0 || c.high <= 0 || c.low <= 0) return false;
        return true;
      });

      // Compress overnight/weekend gaps so candles render contiguously.
      const tfSec = timeframeMsRef.current / 1000;
      const { compressed, realByCompressed } = compressTimes(meaningful, tfSec);

      // Visible signal in devtools console so we can confirm the compression
      // path is running on a hard refresh — if you don't see this line, the
      // tab is serving a stale build.
      // eslint-disable-next-line no-console
      console.log(
        `[useChartData] ${selectedSymbol.symbol} ${timeframe}: raw=${rawCandles.length} kept=${meaningful.length} compressed=${compressed.length} realGapsCollapsed=${realByCompressed.size > 0 ? realByCompressed.size - 1 : 0}`,
      );

      setCandles(compressed);
      candlesRef.current = compressed;
      setRealTimeMap(realByCompressed);

      // Track the most-recent bar's real-time bucket so the WebSocket tick
      // handler can decide whether a new tick extends it or starts a new bar.
      if (meaningful.length > 0) {
        const lastReal = meaningful[meaningful.length - 1].time;
        lastRealBucketRef.current = Math.floor(lastReal / tfSec) * tfSec;
      } else {
        lastRealBucketRef.current = 0;
      }

      if (meaningful.length > 0) {
        const last = meaningful[meaningful.length - 1];
        setCurrentPrice(last.close);
        // Fetch the live quote to get the CORRECT daily change baseline
        // (previous-trading-day close). The previous logic used the FIRST
        // candle in the chart's multi-day window — which on a 7d view of
        // NIFTY meant "comparing today to a week ago", showing -2.77% even
        // when today's actual move was +0.14%.
        try {
          const quoteResp = await api.get(
            `/market-data/instruments/${selectedSymbol.token}/quote`,
            { params: { exchange: selectedSymbol.exchange } },
          );
          const q = quoteResp.data?.quote;
          if (q && typeof q.change === 'number' && typeof q.changePercent === 'number') {
            setPriceChange(q.change);
            setPriceChangePercent(q.changePercent);
            if (typeof q.ltp === 'number' && q.ltp > 0) {
              setCurrentPrice(q.ltp);
            }
          }
        } catch {
          // Quote fetch failed — leave price/change unset rather than show
          // a wrong "across multi-day chart range" value. WS tick will
          // populate them once live ticks resume.
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
  }, [selectedSymbol.token, selectedSymbol.exchange, timeframe]);

  // Fetch OI data. Defensive unwrap with Array.isArray guard so a backend
  // shape change (e.g. wrapping in `{ oi: [...] }`) surfaces as a console
  // warning instead of silently calling .map on a non-array.
  const fetchOI = useCallback(async () => {
    try {
      const response = await api.get(
        `/market-data/instruments/${selectedSymbol.token}/oi`,
      );
      const payload = response.data;
      const candidate =
        (payload?.oi as OIData[] | undefined) ??
        (payload?.data as OIData[] | undefined) ??
        payload;
      const rawOI: OIData[] = Array.isArray(candidate) ? candidate : [];
      if (!Array.isArray(candidate) && payload != null) {
        console.warn('useChartData: unexpected OI response shape');
      }
      setOiData(
        rawOI.map((o) => ({
          time: new Date(o.timestamp).getTime() / 1000,
          value: o.oi,
        })),
      );
    } catch {
      // OI data is optional, fail silently — no chart blocker.
    }
  }, [selectedSymbol.token]);

  useEffect(() => {
    timeframeMsRef.current = getTimeframeDurationMs(timeframe);
    fetchCandles();
    fetchOI();
  }, [fetchCandles, fetchOI, timeframe]);

  // Ensure the symbol is subscribed to the live tick feed. The backend
  // boots with a hardcoded universe (~30 tokens) so anything outside
  // that — ONGC, SBIN, any stock from search — has no live tick stream
  // unless we explicitly ask the backend to subscribe it. POST is
  // idempotent and managed by an LRU pool on the backend; opening many
  // charts won't run away with broker slot budget.
  useEffect(() => {
    if (!selectedSymbol.token || selectedSymbol.token === '0') return;
    api
      .post(
        // Empty {} body — axios sends `null` otherwise, which Express
        // body-parser rejects with strict-mode "not valid JSON" → 400.
        // The endpoint has no @Body() decorator; the empty object is ignored.
        `/market-data/instruments/${selectedSymbol.token}/watch`,
        {},
        { params: { exchange: selectedSymbol.exchange } },
      )
      .catch(() => {
        // Soft failure — historical chart still works, live updates
        // just won't flow for this symbol. Don't surface to user.
      });
  }, [selectedSymbol.token, selectedSymbol.exchange]);

  // Subscribe to WebSocket tick updates for real-time candle building.
  // Live updates have to play nicely with the compressed-time axis: a tick
  // arriving at real time T either extends the current bar (same real-time
  // bucket as the last bar's bucket) or starts a new bar appended at
  // lastCompressedTime + tfSec, regardless of how much real time elapsed.
  useEffect(() => {
    const unsubTick = wsService.subscribe('tick', (data) => {
      const quote = data as Quote;
      if (quote.token !== selectedSymbol.token) return;

      const price = quote.ltp;
      setCurrentPrice(price);
      setPriceChange(quote.change);
      setPriceChangePercent(quote.changePercent);

      setCandles((prev) => {
        if (prev.length === 0) return prev;

        const tickTime = new Date(quote.timestamp).getTime() / 1000;
        const tfSec = timeframeMsRef.current / 1000;
        const tickRealBucket = Math.floor(tickTime / tfSec) * tfSec;

        const last = prev[prev.length - 1];

        if (tickRealBucket === lastRealBucketRef.current) {
          // Same real-time bucket → extend the last bar in place.
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
        } else if (tickRealBucket > lastRealBucketRef.current) {
          // New real-time bucket → append at the next compressed slot
          // (regardless of whether real time skipped overnight/weekend).
          const newCompressedTime = last.time + tfSec;
          setRealTimeMap((m) => {
            const next = new Map(m);
            next.set(newCompressedTime, tickRealBucket);
            return next;
          });
          lastRealBucketRef.current = tickRealBucket;
          const newCandle: ChartCandle = {
            time: newCompressedTime,
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

    // Subscribe to server-side closed candle events (emitted by CandleAggregator).
    // These also need to land on the compressed time axis. We map the real
    // candle timestamp to its bucket, then either replace (if it matches the
    // most-recent bar's bucket) or append at the next compressed slot.
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

      const tfSec = timeframeMsRef.current / 1000;
      const realBucket = Math.floor(new Date(candle.timestamp).getTime() / 1000 / tfSec) * tfSec;

      setCandles((prev) => {
        if (prev.length === 0) {
          // First bar — synthesize a starting compressed time.
          const start = realBucket;
          const newCandle: ChartCandle = {
            time: start,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
          };
          setRealTimeMap((m) => {
            const nm = new Map(m);
            nm.set(start, realBucket);
            return nm;
          });
          lastRealBucketRef.current = realBucket;
          candlesRef.current = [newCandle];
          return [newCandle];
        }

        const last = prev[prev.length - 1];

        if (realBucket === lastRealBucketRef.current) {
          // Replace last bar (server may emit final values for the still-open bar).
          const updated: ChartCandle = {
            time: last.time,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
          };
          const next = [...prev.slice(0, -1), updated];
          candlesRef.current = next;
          return next;
        }

        if (realBucket > lastRealBucketRef.current) {
          const newCompressedTime = last.time + tfSec;
          setRealTimeMap((m) => {
            const nm = new Map(m);
            nm.set(newCompressedTime, realBucket);
            return nm;
          });
          lastRealBucketRef.current = realBucket;
          const newCandle: ChartCandle = {
            time: newCompressedTime,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
          };
          const next = [...prev, newCandle];
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

  return {
    candles,
    oiData,
    isLoading,
    error,
    currentPrice,
    priceChange,
    priceChangePercent,
    realTimeMap,
  };
}