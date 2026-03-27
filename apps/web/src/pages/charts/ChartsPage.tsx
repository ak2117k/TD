import { LineChart } from 'lucide-react';

export default function ChartsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <LineChart size={24} className="text-[var(--color-accent-blue)]" />
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Charts</h1>
      </div>

      <p className="text-sm text-[var(--color-text-secondary)]">
        Advanced candlestick charts with technical indicators, drawing tools, and multi-timeframe analysis powered by Lightweight Charts.
      </p>

      <div className="flex h-[500px] items-center justify-center rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]">
        <div className="text-center">
          <LineChart size={48} className="mx-auto mb-3 text-[var(--color-text-muted)]" />
          <p className="text-sm text-[var(--color-text-muted)]">
            Interactive TradingView-style charts will render here
          </p>
        </div>
      </div>
    </div>
  );
}
