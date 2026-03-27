import { LayoutDashboard, TrendingUp, TrendingDown, Activity } from 'lucide-react';

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <LayoutDashboard size={24} className="text-[var(--color-accent-blue)]" />
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Dashboard</h1>
      </div>

      <p className="text-sm text-[var(--color-text-secondary)]">
        Portfolio overview, P&L summary, open positions, and active signals at a glance.
      </p>

      {/* Placeholder stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Today P&L', value: '--', icon: TrendingUp, color: 'var(--color-accent-green)' },
          { label: 'Open Positions', value: '--', icon: Activity, color: 'var(--color-accent-blue)' },
          { label: 'Win Rate', value: '--', icon: TrendingUp, color: 'var(--color-accent-yellow)' },
          { label: 'Max Drawdown', value: '--', icon: TrendingDown, color: 'var(--color-accent-red)' },
        ].map((card) => (
          <div
            key={card.label}
            className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                {card.label}
              </span>
              <card.icon size={16} style={{ color: card.color }} />
            </div>
            <p className="mt-3 text-2xl font-bold text-[var(--color-text-primary)]">{card.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-8 text-center">
        <p className="text-sm text-[var(--color-text-muted)]">
          Live portfolio charts and position details will appear here once connected to the backend.
        </p>
      </div>
    </div>
  );
}
