import { Grid3X3 } from 'lucide-react';

export default function OptionsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Grid3X3 size={24} className="text-[var(--color-accent-blue)]" />
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Options Chain</h1>
      </div>

      <p className="text-sm text-[var(--color-text-secondary)]">
        Full options chain with Greeks, OI analysis, IV surface visualization, and strategy builder for NIFTY and BANKNIFTY.
      </p>

      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-8 text-center">
        <Grid3X3 size={48} className="mx-auto mb-3 text-[var(--color-text-muted)]" />
        <p className="text-sm text-[var(--color-text-muted)]">
          Options chain table with strike prices, premiums, OI, and Greeks will load here.
        </p>
      </div>
    </div>
  );
}
