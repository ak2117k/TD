import { FlaskConical } from 'lucide-react';

export default function BacktestPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <FlaskConical size={24} className="text-[var(--color-accent-yellow)]" />
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Backtest</h1>
      </div>

      <p className="text-sm text-[var(--color-text-secondary)]">
        Run strategy backtests on historical data, visualize equity curves, analyze drawdowns, and compare strategy performance metrics.
      </p>

      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-8 text-center">
        <FlaskConical size={48} className="mx-auto mb-3 text-[var(--color-text-muted)]" />
        <p className="text-sm text-[var(--color-text-muted)]">
          Backtest configuration, equity curves, and performance reports will render here.
        </p>
      </div>
    </div>
  );
}
