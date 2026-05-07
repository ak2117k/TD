import type { ReactNode } from 'react';
import clsx from 'clsx';

/**
 * Shared card shell for the StockOverviewPanel. All seven cards drop into
 * this same chrome so the panel reads as a coherent stack rather than a
 * grab-bag of one-off components. The optional `action` slot is for the
 * top-right link/badge ("View full chain →", "Coming soon", etc.).
 */
export function Card({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        'rounded-lg border border-zinc-800 bg-zinc-900/50 p-4',
        className,
      )}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-zinc-300">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

/**
 * Compact label/value pair used in LiveQuoteCard and similar dense rows.
 */
export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-sm text-zinc-200 tabular-nums">{value}</div>
    </div>
  );
}
