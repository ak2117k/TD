import { Bot } from 'lucide-react';

export default function AutoTradePage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Bot size={24} className="text-[var(--color-accent-green)]" />
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Auto-Trade</h1>
      </div>

      <p className="text-sm text-[var(--color-text-secondary)]">
        Automated trading controls: enable/disable strategies, set risk parameters, monitor execution logs, and toggle between paper and live modes.
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {['Paper Trading', 'Approval Required', 'Fully Automatic'].map((mode) => (
          <div
            key={mode}
            className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5 text-center"
          >
            <p className="text-sm font-medium text-[var(--color-text-primary)]">{mode}</p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">Click to activate</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-8 text-center">
        <p className="text-sm text-[var(--color-text-muted)]">
          Strategy controls and execution logs will appear here.
        </p>
      </div>
    </div>
  );
}
