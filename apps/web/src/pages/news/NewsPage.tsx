import { Newspaper } from 'lucide-react';

export default function NewsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Newspaper size={24} className="text-[var(--color-accent-blue)]" />
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">News</h1>
      </div>

      <p className="text-sm text-[var(--color-text-secondary)]">
        Curated financial news feed with AI sentiment analysis, sector categorization, and impact assessment on your portfolio.
      </p>

      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-8 text-center">
        <Newspaper size={48} className="mx-auto mb-3 text-[var(--color-text-muted)]" />
        <p className="text-sm text-[var(--color-text-muted)]">
          News articles with sentiment badges and related symbols will load here.
        </p>
      </div>
    </div>
  );
}
