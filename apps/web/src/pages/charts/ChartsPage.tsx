import { useState, useRef, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { CandlestickChart, ChartToolbar, IndicatorPanel, OIOverlay } from '@/components/charts';
import type { CandlestickChartHandle } from '@/components/charts';
import { useChartData } from '@/hooks/useChartData';
import { useChartStore, type SelectedSymbol } from '@/stores/chart-store';

const WATCHLIST_ITEMS: SelectedSymbol[] = [
  { symbol: 'NIFTY', token: '99926000', exchange: 'NSE', name: 'NIFTY 50' },
  { symbol: 'BANKNIFTY', token: '99926009', exchange: 'NSE', name: 'BANK NIFTY' },
  { symbol: 'FINNIFTY', token: '99926037', exchange: 'NSE', name: 'FIN NIFTY' },
  { symbol: 'SENSEX', token: '99919000', exchange: 'BSE', name: 'SENSEX' },
  { symbol: 'NIFTY MIDCAP 50', token: '99926025', exchange: 'NSE', name: 'NIFTY MIDCAP' },
  { symbol: 'NIFTY IT', token: '99926013', exchange: 'NSE', name: 'NIFTY IT' },
];

interface CrosshairData {
  open: number;
  high: number;
  low: number;
  close: number;
  time: number;
}

export default function ChartsPage() {
  const chartRef = useRef<CandlestickChartHandle>(null);
  const [showIndicators, setShowIndicators] = useState(false);
  const [crosshairData, setCrosshairData] = useState<CrosshairData | null>(null);
  const [searchParams] = useSearchParams();

  const selectedSymbol = useChartStore((s) => s.selectedSymbol);
  const setSymbol = useChartStore((s) => s.setSymbol);
  const indicators = useChartStore((s) => s.indicators);
  const isFullscreen = useChartStore((s) => s.isFullscreen);

  // Sync chart store with URL query params (e.g. navigating from Market page)
  useEffect(() => {
    const symbol = searchParams.get('symbol');
    const exchange = searchParams.get('exchange');
    const token = searchParams.get('token');
    if (symbol) {
      setSymbol({
        symbol,
        token: token ?? '',
        exchange: exchange ?? 'NSE',
        name: symbol,
      });
    }
  }, [searchParams, setSymbol]); // eslint-disable-line react-hooks/exhaustive-deps

  const { candles, oiData, isLoading, error, currentPrice, priceChange, priceChangePercent } =
    useChartData();

  const handleCrosshairMove = useCallback((params: unknown) => {
    const p = params as { seriesData?: Map<unknown, unknown> };
    if (!p.seriesData || p.seriesData.size === 0) {
      setCrosshairData(null);
      return;
    }
    // Get first series data (candlestick)
    const values = p.seriesData.values();
    const first = values.next().value as CrosshairData | undefined;
    if (first && 'open' in first) {
      setCrosshairData(first);
    }
  }, []);

  const ohlcData = crosshairData ?? (candles.length > 0 ? candles[candles.length - 1] : null);
  const ohlcUp = ohlcData ? ohlcData.close >= ohlcData.open : true;

  return (
    <div
      className={clsx(
        'flex flex-col',
        isFullscreen ? 'fixed inset-0 z-50 bg-[var(--color-bg-primary)]' : 'h-[calc(100vh-64px)]',
      )}
    >
      {/* Toolbar */}
      <ChartToolbar
        currentPrice={currentPrice}
        priceChange={priceChange}
        priceChangePercent={priceChangePercent}
        onToggleIndicators={() => setShowIndicators(!showIndicators)}
        showIndicatorPanel={showIndicators}
      />

      {/* OHLCV data bar */}
      {ohlcData && (
        <div className="flex items-center gap-4 px-4 py-1.5 bg-[var(--color-bg-primary)] border-b border-[var(--color-border-subtle)] text-xs">
          <OHLCItem label="O" value={ohlcData.open} up={ohlcUp} />
          <OHLCItem label="H" value={ohlcData.high} up={ohlcUp} />
          <OHLCItem label="L" value={ohlcData.low} up={ohlcUp} />
          <OHLCItem label="C" value={ohlcData.close} up={ohlcUp} />
        </div>
      )}

      {/* Main content area */}
      <div className="flex flex-1 min-h-0">
        {/* Watchlist sidebar */}
        {!isFullscreen && (
          <div className="w-48 shrink-0 border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] overflow-y-auto">
            <div className="px-3 py-2 border-b border-[var(--color-border-subtle)]">
              <h3 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                Watchlist
              </h3>
            </div>
            {WATCHLIST_ITEMS.map((item) => {
              const isActive = item.token === selectedSymbol.token;
              return (
                <button
                  key={item.token}
                  onClick={() => setSymbol(item)}
                  className={clsx(
                    'w-full px-3 py-2.5 text-left border-b border-[var(--color-border-subtle)] transition-colors',
                    isActive
                      ? 'bg-[var(--color-bg-tertiary)] border-l-2 border-l-[var(--color-accent-blue)]'
                      : 'hover:bg-[var(--color-bg-tertiary)]',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={clsx(
                        'text-xs font-medium',
                        isActive
                          ? 'text-[var(--color-text-primary)]'
                          : 'text-[var(--color-text-secondary)]',
                      )}
                    >
                      {item.symbol}
                    </span>
                    {isActive && (
                      <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent-blue)]" />
                    )}
                  </div>
                  <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                    {item.exchange}
                  </p>
                </button>
              );
            })}
          </div>
        )}

        {/* Chart area */}
        <div className="flex-1 relative min-w-0">
          {isLoading && candles.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-bg-primary)] z-10">
              <div className="flex flex-col items-center gap-3">
                <div className="w-8 h-8 border-2 border-[var(--color-accent-blue)] border-t-transparent rounded-full animate-spin" />
                <span className="text-sm text-[var(--color-text-muted)]">Loading chart data...</span>
              </div>
            </div>
          )}

          {error && candles.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-bg-primary)] z-10">
              <div className="text-center">
                <p className="text-sm text-[var(--color-accent-red)]">{error}</p>
                <p className="text-xs text-[var(--color-text-muted)] mt-1">
                  Displaying demo data
                </p>
              </div>
            </div>
          )}

          <CandlestickChart
            key={selectedSymbol.token}
            ref={chartRef}
            candles={candles}
            onCrosshairMove={handleCrosshairMove}
            showVolume={indicators.volume}
          />

          {/* OI Overlay (renders onto the chart, no DOM) */}
          <OIOverlay
            chart={chartRef.current?.chart ?? null}
            oiData={oiData}
            visible={indicators.oi}
          />

          {/* Indicator panel overlay */}
          {showIndicators && (
            <IndicatorPanel
              onClose={() => setShowIndicators(false)}
              chart={chartRef.current?.chart ?? null}
              candles={candles}
            />
          )}

          {/* Watermark */}
          <div className="absolute top-4 left-4 pointer-events-none select-none z-20">
            <span className="text-2xl font-bold text-[var(--color-text-primary)] opacity-10">
              {selectedSymbol.symbol}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function OHLCItem({ label, value, up }: { label: string; value: number; up: boolean }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <span
        className={clsx(
          'font-medium tabular-nums',
          up ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]',
        )}
      >
        {value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    </div>
  );
}
