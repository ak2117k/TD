import { BookOpen } from 'lucide-react';

export default function JournalPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <BookOpen size={24} className="text-[var(--color-accent-blue)]" />
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Trade Journal</h1>
      </div>

      <p className="text-sm text-[var(--color-text-secondary)]">
        Detailed trade history with performance analytics, P&L breakdown, strategy win-rate tracking, and exportable reports.
      </p>

      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-8 text-center">
        <BookOpen size={48} className="mx-auto mb-3 text-[var(--color-text-muted)]" />
        <p className="text-sm text-[var(--color-text-muted)]">
          Trade log entries with filters and performance metrics will display here.
        </p>
      </div>
    </div>
  );
}
