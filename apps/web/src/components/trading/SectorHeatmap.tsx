const SECTORS = [
  { name: 'IT', change: 1.25 },
  { name: 'Banking', change: -0.45 },
  { name: 'Pharma', change: 0.78 },
  { name: 'Auto', change: -1.12 },
  { name: 'FMCG', change: 0.32 },
  { name: 'Metal', change: 2.1 },
  { name: 'Energy', change: -0.67 },
  { name: 'Realty', change: 1.85 },
  { name: 'Infra', change: 0.55 },
  { name: 'Media', change: -0.22 },
  { name: 'PSU Bank', change: -1.35 },
  { name: 'Pvt Bank', change: 0.18 },
  { name: 'Fin Services', change: -0.08 },
  { name: 'Healthcare', change: 0.92 },
  { name: 'Consumer', change: 0.41 },
  { name: 'Telecom', change: 1.05 },
];

function getHeatColor(change: number): string {
  const intensity = Math.min(Math.abs(change) / 2.5, 1);
  if (change >= 0) {
    const r = Math.round(10 + (0 - 10) * intensity);
    const g = Math.round(30 + (207 - 30) * intensity);
    const b = Math.round(20 + (132 - 20) * intensity);
    return `rgb(${r}, ${g}, ${b})`;
  } else {
    const r = Math.round(30 + (239 - 30) * intensity);
    const g = Math.round(20 + (68 - 20) * intensity);
    const b = Math.round(20 + (68 - 20) * intensity);
    return `rgb(${r}, ${g}, ${b})`;
  }
}

export default function SectorHeatmap() {
  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
      <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">Sector Heatmap</h3>
      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-4 md:grid-cols-8">
        {SECTORS.map((sector) => (
          <div
            key={sector.name}
            className="flex flex-col items-center justify-center rounded-lg px-2 py-3 transition-transform hover:scale-105"
            style={{ backgroundColor: getHeatColor(sector.change) + '33' }}
          >
            <span className="text-[10px] font-semibold text-[var(--color-text-primary)]">
              {sector.name}
            </span>
            <span
              className="mt-0.5 text-xs font-bold"
              style={{ color: getHeatColor(sector.change) }}
            >
              {sector.change >= 0 ? '+' : ''}{sector.change.toFixed(2)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
