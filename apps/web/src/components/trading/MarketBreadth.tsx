import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

// Placeholder data - will be wired to live data later
const BREADTH = {
  advances: 1247,
  declines: 823,
  unchanged: 112,
};

export default function MarketBreadth() {
  const total = BREADTH.advances + BREADTH.declines + BREADTH.unchanged;
  const advPct = (BREADTH.advances / total) * 100;
  const decPct = (BREADTH.declines / total) * 100;

  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
      <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">Market Breadth</h3>

      {/* Bar */}
      <div className="flex h-3 w-full overflow-hidden rounded-full">
        <div
          className="rounded-l-full bg-[var(--color-accent-green)]"
          style={{ width: `${advPct}%` }}
        />
        <div
          className="bg-[var(--color-text-muted)]"
          style={{ width: `${100 - advPct - decPct}%` }}
        />
        <div
          className="rounded-r-full bg-[var(--color-accent-red)]"
          style={{ width: `${decPct}%` }}
        />
      </div>

      {/* Legend */}
      <div className="mt-3 flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5">
          <TrendingUp size={12} className="text-[var(--color-accent-green)]" />
          <span className="text-[var(--color-text-secondary)]">Advances</span>
          <span className="font-bold text-[var(--color-accent-green)]">{BREADTH.advances}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Minus size={12} className="text-[var(--color-text-muted)]" />
          <span className="text-[var(--color-text-secondary)]">Unchanged</span>
          <span className="font-bold text-[var(--color-text-muted)]">{BREADTH.unchanged}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <TrendingDown size={12} className="text-[var(--color-accent-red)]" />
          <span className="text-[var(--color-text-secondary)]">Declines</span>
          <span className="font-bold text-[var(--color-accent-red)]">{BREADTH.declines}</span>
        </div>
      </div>

      {/* Ratio */}
      <div className="mt-2 text-center">
        <span className="text-[10px] text-[var(--color-text-muted)]">
          A/D Ratio: {(BREADTH.advances / BREADTH.declines).toFixed(2)}
        </span>
      </div>
    </div>
  );
}
