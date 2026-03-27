import { Brain } from 'lucide-react';

export default function AdvisorPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Brain size={24} className="text-purple-400" />
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">AI Advisor</h1>
      </div>

      <p className="text-sm text-[var(--color-text-secondary)]">
        AI-powered trading assistant with market analysis, portfolio suggestions, risk warnings, and conversational interface for strategy queries.
      </p>

      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-8 text-center">
        <Brain size={48} className="mx-auto mb-3 text-[var(--color-text-muted)]" />
        <p className="text-sm text-[var(--color-text-muted)]">
          AI insights, market analysis cards, and chat interface will be available here.
        </p>
      </div>
    </div>
  );
}
