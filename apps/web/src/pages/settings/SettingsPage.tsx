import { Settings } from 'lucide-react';

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Settings size={24} className="text-[var(--color-text-secondary)]" />
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Settings</h1>
      </div>

      <p className="text-sm text-[var(--color-text-secondary)]">
        Configure broker API credentials, risk management limits, notification preferences, theme, and auto-trade parameters.
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {[
          { title: 'Broker Connection', desc: 'API keys and authentication' },
          { title: 'Risk Management', desc: 'Max loss, position sizing, limits' },
          { title: 'Notifications', desc: 'Alerts, signals, trade confirmations' },
          { title: 'Strategies', desc: 'Enable/disable and configure strategies' },
        ].map((section) => (
          <div
            key={section.title}
            className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5"
          >
            <p className="text-sm font-medium text-[var(--color-text-primary)]">{section.title}</p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">{section.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
