import { Zap } from 'lucide-react';

export default function SignalsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Zap size={24} className="text-[var(--color-accent-yellow)]" />
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Signals</h1>
      </div>

      <p className="text-sm text-[var(--color-text-secondary)]">
        AI-generated trade signals with confidence scores, entry/exit levels, risk-reward analysis, and one-click execution.
      </p>

      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-8 text-center">
        <Zap size={48} className="mx-auto mb-3 text-[var(--color-text-muted)]" />
        <p className="text-sm text-[var(--color-text-muted)]">
          Live and historical trade signals will stream here in real-time.
        </p>
      </div>
    </div>
  );
}
