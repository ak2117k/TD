import { Globe } from 'lucide-react';

export default function MarketPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Globe size={24} className="text-[var(--color-accent-blue)]" />
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Market Overview</h1>
      </div>

      <p className="text-sm text-[var(--color-text-secondary)]">
        Live market indices, sector performance heatmap, top gainers/losers, and real-time quote watchlists.
      </p>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {['NIFTY 50', 'BANK NIFTY', 'SENSEX'].map((index) => (
          <div
            key={index}
            className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5"
          >
            <span className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              {index}
            </span>
            <p className="mt-2 text-2xl font-bold text-[var(--color-text-primary)]">--,---</p>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">-- (--%) awaiting data</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-8 text-center">
        <p className="text-sm text-[var(--color-text-muted)]">
          Sector heatmap and watchlist tables will populate with live market data.
        </p>
      </div>
    </div>
  );
}
