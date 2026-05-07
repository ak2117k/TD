import { Card } from './_shared';

const FIELDS: { label: string }[] = [
  { label: 'Sector' },
  { label: 'Industry' },
  { label: 'Market Cap' },
  { label: 'P/E' },
  { label: 'P/B' },
  { label: 'EPS' },
  { label: 'ROE' },
  { label: 'Debt / Equity' },
];

/**
 * Card 7: Fundamentals placeholder. No data source yet — we don't currently
 * pull fundamentals through Angel One, and the spec defers a real provider
 * choice to a later phase. Renders a static grid with em-dashes for every
 * field plus a "Coming soon" pill so the slot is visually committed.
 */
export default function FundamentalsStubCard() {
  return (
    <Card
      title="Fundamentals"
      action={<span className="text-xs text-zinc-500 italic">Coming soon</span>}
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {FIELDS.map((f) => (
          <div key={f.label}>
            <div className="text-xs text-zinc-500">{f.label}</div>
            <div className="text-sm text-zinc-400">—</div>
          </div>
        ))}
      </div>
    </Card>
  );
}
