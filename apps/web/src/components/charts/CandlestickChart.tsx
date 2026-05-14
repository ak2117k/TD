import { useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type CandlestickSeriesOptions,
  type DeepPartial,
  type MouseEventParams,
  type Time,
} from 'lightweight-charts';

export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandlestickChartHandle {
  chart: IChartApi | null;
  candleSeries: ISeriesApi<'Candlestick'> | null;
  fitContent: () => void;
}

interface CandlestickChartProps {
  candles: ChartCandle[];
  width?: number;
  height?: number;
  onCrosshairMove?: (params: MouseEventParams<Time>) => void;
  showVolume?: boolean;
  // Maps the compressed time on the chart's axis to the real (unix) time
  // of the underlying candle. When provided, the time-axis labels and
  // crosshair tooltips show real market times instead of the synthetic
  // gap-collapsed timestamps.
  realTimeMap?: Map<number, number>;
}

function formatRealTime(realSec: number): string {
  const d = new Date(realSec * 1000);
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatRealTimeShort(realSec: number): string {
  const d = new Date(realSec * 1000);
  return d.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

const CandlestickChart = forwardRef<CandlestickChartHandle, CandlestickChartProps>(
  function CandlestickChart(
    { candles, width, height, onCrosshairMove, showVolume = true, realTimeMap },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
    const prevCandlesLenRef = useRef(0);
    const prevFirstCandleTimeRef = useRef<number | null>(null);
    // Hold the latest realTimeMap in a ref so chart-level formatters (created
    // once at mount) can always read the current map without re-creating the
    // chart on every prop change.
    const realTimeMapRef = useRef<Map<number, number> | undefined>(realTimeMap);
    useEffect(() => {
      realTimeMapRef.current = realTimeMap;
    }, [realTimeMap]);

    useImperativeHandle(ref, () => ({
      get chart() {
        return chartRef.current;
      },
      get candleSeries() {
        return candleSeriesRef.current;
      },
      fitContent: () => {
        chartRef.current?.timeScale().fitContent();
      },
    }));

    // Initialize chart
    useEffect(() => {
      if (!containerRef.current) return;

      const chart = createChart(containerRef.current, {
        layout: {
          background: { type: ColorType.Solid, color: '#0a0a1a' },
          textColor: '#94a3b8',
          fontSize: 12,
        },
        grid: {
          vertLines: { color: 'rgba(30, 41, 59, 0.5)' },
          horzLines: { color: 'rgba(30, 41, 59, 0.5)' },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: {
            color: 'rgba(59, 130, 246, 0.4)',
            labelBackgroundColor: '#3b82f6',
          },
          horzLine: {
            color: 'rgba(59, 130, 246, 0.4)',
            labelBackgroundColor: '#3b82f6',
          },
        },
        rightPriceScale: {
          borderColor: '#1e293b',
          scaleMargins: {
            top: 0.05,
            bottom: showVolume ? 0.25 : 0.05,
          },
        },
        timeScale: {
          borderColor: '#1e293b',
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 5,
          barSpacing: 6,
          // Don't let the chart try to render bars so thin they vanish.
          // fitContent() respects this floor — if all bars can't fit at >=
          // minBarSpacing, the chart scrolls horizontally instead.
          minBarSpacing: 2,
          // Translate the chart's compressed time back to the real market
          // time when labelling the bottom axis. If no map is provided
          // (e.g. very early during initial load), fall back to formatting
          // the raw value so labels never go blank.
          tickMarkFormatter: (time: Time) => {
            const t = time as number;
            const real = realTimeMapRef.current?.get(t) ?? t;
            return formatRealTimeShort(real);
          },
        },
        localization: {
          // Same translation for the crosshair tooltip on the time axis.
          timeFormatter: (time: number) => {
            const real = realTimeMapRef.current?.get(time) ?? time;
            return formatRealTime(real);
          },
        },
        width: width ?? containerRef.current.clientWidth,
        height: height ?? containerRef.current.clientHeight,
      });

      const candleOptions: DeepPartial<CandlestickSeriesOptions> = {
        upColor: '#00cf84',
        downColor: '#ef4444',
        borderUpColor: '#00cf84',
        borderDownColor: '#ef4444',
        wickUpColor: '#00cf84',
        wickDownColor: '#ef4444',
      };

      const candleSeries = chart.addCandlestickSeries(candleOptions);
      candleSeriesRef.current = candleSeries;

      // Volume histogram on the same chart
      const volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
      });

      chart.priceScale('volume').applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
        borderVisible: false,
      });

      volumeSeriesRef.current = volumeSeries;

      chartRef.current = chart;

      // Crosshair callback
      if (onCrosshairMove) {
        chart.subscribeCrosshairMove(onCrosshairMove);
      }

      // ResizeObserver for auto-resize
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width: w, height: h } = entry.contentRect;
          if (w > 0 && h > 0) {
            chart.applyOptions({ width: w, height: h });
          }
        }
      });

      if (!width && !height) {
        resizeObserver.observe(containerRef.current);
      }

      return () => {
        resizeObserver.disconnect();
        if (onCrosshairMove) {
          chart.unsubscribeCrosshairMove(onCrosshairMove);
        }
        chart.remove();
        chartRef.current = null;
        candleSeriesRef.current = null;
        volumeSeriesRef.current = null;
        prevCandlesLenRef.current = 0;
        prevFirstCandleTimeRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Update candle data
    const updateData = useCallback(() => {
      if (!candleSeriesRef.current || !volumeSeriesRef.current) return;

      // Clear chart when candles are empty (e.g. symbol just changed)
      if (candles.length === 0) {
        candleSeriesRef.current.setData([]);
        volumeSeriesRef.current.setData([]);
        prevCandlesLenRef.current = 0;
        prevFirstCandleTimeRef.current = null;
        return;
      }

      const candleData = candles.map((c) => ({
        time: Math.floor(c.time) as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));

      const volumeData = candles.map((c) => ({
        time: Math.floor(c.time) as Time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(0, 207, 132, 0.35)' : 'rgba(239, 68, 68, 0.35)',
      }));

      // Detect a symbol/dataset change: if the first candle's timestamp differs
      // from what we saw before, this is a completely new dataset — force a full
      // setData() by resetting the incremental counter.
      const newFirstTime = candles[0].time;
      if (prevFirstCandleTimeRef.current !== null && prevFirstCandleTimeRef.current !== newFirstTime) {
        prevCandlesLenRef.current = 0;
      }

      const isIncremental =
        prevCandlesLenRef.current > 0 &&
        Math.abs(candles.length - prevCandlesLenRef.current) <= 1;

      if (isIncremental) {
        // Real-time update: try to update/append the last candle
        try {
          const lastCandle = candleData[candleData.length - 1];
          const lastVolume = volumeData[volumeData.length - 1];
          candleSeriesRef.current.update(lastCandle);
          volumeSeriesRef.current.update(lastVolume);
        } catch {
          // Fallback to full setData if update fails (e.g. time out of order)
          candleSeriesRef.current.setData(candleData);
          volumeSeriesRef.current.setData(volumeData);
        }
      } else {
        candleSeriesRef.current.setData(candleData);
        volumeSeriesRef.current.setData(volumeData);

        // Fit content on every dataset reset (initial load OR symbol/timeframe
        // change). Deferred to next tick because calling fitContent()
        // synchronously after setData() races the chart's internal state —
        // it fits to the OLD range, leaving the new candles squished into
        // the right edge with empty space to the left.
        if (prevCandlesLenRef.current === 0) {
          requestAnimationFrame(() => {
            chartRef.current?.timeScale().fitContent();
          });
        }
      }

      prevCandlesLenRef.current = candles.length;
      prevFirstCandleTimeRef.current = newFirstTime;
    }, [candles]);

    useEffect(() => {
      updateData();
    }, [updateData]);

    // Toggle volume visibility
    useEffect(() => {
      if (!volumeSeriesRef.current) return;
      volumeSeriesRef.current.applyOptions({
        visible: showVolume,
      });
    }, [showVolume]);

    return (
      <div
        ref={containerRef}
        style={{
          width: width ? `${width}px` : '100%',
          height: height ? `${height}px` : '100%',
          minHeight: '300px',
        }}
      />
    );
  },
);

export default CandlestickChart;
