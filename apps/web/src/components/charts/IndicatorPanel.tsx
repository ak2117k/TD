import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { useChartStore, type IndicatorState } from '@/stores/chart-store';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';

interface IndicatorConfig {
  key: keyof IndicatorState;
  label: string;
  description: string;
  color: string;
  ready: boolean;
}

const INDICATORS: IndicatorConfig[] = [
  { key: 'ema20', label: 'EMA 20', description: 'Exponential MA (20)', color: '#3b82f6', ready: true },
  { key: 'ema50', label: 'EMA 50', description: 'Exponential MA (50)', color: '#a855f7', ready: true },
  { key: 'ema200', label: 'EMA 200', description: 'Exponential MA (200)', color: '#f59e0b', ready: true },
  { key: 'volume', label: 'Volume', description: 'Volume histogram', color: '#64748b', ready: true },
  { key: 'oi', label: 'OI', description: 'Open Interest overlay', color: '#fbbf24', ready: true },
  { key: 'rsi', label: 'RSI', description: 'Relative Strength Index', color: '#06b6d4', ready: false },
  { key: 'bollinger', label: 'Bollinger', description: 'Bollinger Bands', color: '#ec4899', ready: false },
  { key: 'vwap', label: 'VWAP', description: 'Volume Weighted Avg Price', color: '#10b981', ready: false },
];

interface IndicatorPanelProps {
  onClose: () => void;
  chart: IChartApi | null;
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
}

// Calculate EMA
function calculateEMA(closes: number[], period: number): (number | null)[] {
  const ema: (number | null)[] = [];
  if (closes.length < period) {
    return closes.map(() => null);
  }

  const k = 2 / (period + 1);

  // Start with SMA for the first value
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += closes[i];
    ema.push(null);
  }
  ema[period - 1] = sum / period;

  for (let i = period; i < closes.length; i++) {
    const prev = ema[i - 1] as number;
    ema.push(closes[i] * k + prev * (1 - k));
  }

  return ema;
}

export default function IndicatorPanel({ onClose, chart, candles }: IndicatorPanelProps) {
  const indicators = useChartStore((s) => s.indicators);
  const toggleIndicator = useChartStore((s) => s.toggleIndicator);
  const emaSeriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());

  const handleToggle = (indicator: IndicatorConfig) => {
    if (!indicator.ready) {
      toast('Coming soon! This indicator is under development.', {
        icon: '🔧',
        style: {
          background: '#1a1a2e',
          color: '#f1f5f9',
          border: '1px solid #334155',
        },
      });
      return;
    }
    toggleIndicator(indicator.key);
  };

  // Manage EMA line series on the chart
  useEffect(() => {
    if (!chart || candles.length === 0) return;

    const closes = candles.map((c) => c.close);
    const emaConfigs = [
      { key: 'ema20', period: 20, color: '#3b82f6' },
      { key: 'ema50', period: 50, color: '#a855f7' },
      { key: 'ema200', period: 200, color: '#f59e0b' },
    ];

    for (const config of emaConfigs) {
      const enabled = indicators[config.key as keyof IndicatorState];
      const existing = emaSeriesRef.current.get(config.key);

      if (enabled && !existing) {
        // Add EMA series
        const series = chart.addLineSeries({
          color: config.color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });

        const emaValues = calculateEMA(closes, config.period);
        const lineData = candles
          .map((c, i) =>
            emaValues[i] !== null
              ? { time: c.time as Time, value: emaValues[i] as number }
              : null,
          )
          .filter(Boolean) as Array<{ time: Time; value: number }>;

        series.setData(lineData);
        emaSeriesRef.current.set(config.key, series);
      } else if (enabled && existing) {
        // Update data
        const emaValues = calculateEMA(closes, config.period);
        const lineData = candles
          .map((c, i) =>
            emaValues[i] !== null
              ? { time: c.time as Time, value: emaValues[i] as number }
              : null,
          )
          .filter(Boolean) as Array<{ time: Time; value: number }>;

        existing.setData(lineData);
      } else if (!enabled && existing) {
        // Remove series
        try {
          chart.removeSeries(existing);
        } catch {
          // Chart may be disposed
        }
        emaSeriesRef.current.delete(config.key);
      }
    }
  }, [chart, candles, indicators]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (!chart) return;
      for (const [, series] of emaSeriesRef.current) {
        try {
          chart.removeSeries(series);
        } catch {
          // ignore
        }
      }
      emaSeriesRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="absolute top-0 right-0 w-64 bg-[var(--color-bg-secondary)] border-l border-[var(--color-border-subtle)] z-40 h-full overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border-subtle)]">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Indicators</h3>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      <div className="p-3 space-y-1">
        {INDICATORS.map((indicator) => {
          const active = indicators[indicator.key];
          return (
            <button
              key={indicator.key}
              onClick={() => handleToggle(indicator)}
              className={clsx(
                'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors',
                active
                  ? 'bg-[var(--color-bg-tertiary)]'
                  : 'hover:bg-[var(--color-bg-tertiary)]',
              )}
            >
              <div
                className={clsx(
                  'w-2.5 h-2.5 rounded-full shrink-0 transition-opacity',
                  active ? 'opacity-100' : 'opacity-30',
                )}
                style={{ backgroundColor: indicator.color }}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={clsx(
                      'text-xs font-medium',
                      active
                        ? 'text-[var(--color-text-primary)]'
                        : 'text-[var(--color-text-secondary)]',
                    )}
                  >
                    {indicator.label}
                  </span>
                  {!indicator.ready && (
                    <span className="text-[9px] px-1 py-px rounded bg-[var(--color-bg-primary)] text-[var(--color-text-muted)]">
                      SOON
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-[var(--color-text-muted)] truncate">
                  {indicator.description}
                </p>
              </div>
              <div
                className={clsx(
                  'w-8 h-4 rounded-full flex items-center transition-colors px-0.5',
                  active ? 'bg-[var(--color-accent-blue)] justify-end' : 'bg-[var(--color-border-default)] justify-start',
                )}
              >
                <div className="w-3 h-3 rounded-full bg-white shadow-sm" />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
