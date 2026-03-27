import { useMemo } from 'react';
import { cn } from '@/utils/cn';
import type { OptionsChainEntry } from '@/types';

interface OIAnalysisProps {
  chain: OptionsChainEntry[];
  spotPrice: number;
}

export default function OIAnalysis({ chain, spotPrice }: OIAnalysisProps) {
  const analysis = useMemo(() => {
    let totalCEOI = 0;
    let totalPEOI = 0;
    let highestCEOI = 0;
    let highestPEOI = 0;
    let highestCEOIStrike = 0;
    let highestPEOIStrike = 0;

    for (const entry of chain) {
      if (entry.ceData) {
        totalCEOI += entry.ceData.oi;
        if (entry.ceData.oi > highestCEOI) {
          highestCEOI = entry.ceData.oi;
          highestCEOIStrike = entry.strikePrice;
        }
      }
      if (entry.peData) {
        totalPEOI += entry.peData.oi;
        if (entry.peData.oi > highestPEOI) {
          highestPEOI = entry.peData.oi;
          highestPEOIStrike = entry.strikePrice;
        }
      }
    }

    const pcr = totalCEOI === 0 ? 0 : totalPEOI / totalCEOI;

    // Max pain calculation
    let maxPainStrike = 0;
    let minPain = Infinity;
    for (const entry of chain) {
      let totalPain = 0;
      for (const e of chain) {
        if (e.ceData && entry.strikePrice > e.strikePrice) {
          totalPain += (entry.strikePrice - e.strikePrice) * e.ceData.oi;
        }
        if (e.peData && entry.strikePrice < e.strikePrice) {
          totalPain += (e.strikePrice - entry.strikePrice) * e.peData.oi;
        }
      }
      if (totalPain < minPain) {
        minPain = totalPain;
        maxPainStrike = entry.strikePrice;
      }
    }

    return {
      totalCEOI,
      totalPEOI,
      pcr: Math.round(pcr * 100) / 100,
      maxPainStrike,
      highestCEOIStrike,
      highestPEOIStrike,
      highestCEOI,
      highestPEOI,
    };
  }, [chain]);

  const pcrInterpretation =
    analysis.pcr > 1
      ? { text: 'Bullish', color: 'text-[var(--color-accent-green)]' }
      : analysis.pcr < 0.7
        ? { text: 'Bearish', color: 'text-[var(--color-accent-red)]' }
        : { text: 'Neutral', color: 'text-[var(--color-accent-yellow)]' };

  const maxOI = Math.max(analysis.totalCEOI, analysis.totalPEOI, 1);
  const ceBarWidth = (analysis.totalCEOI / maxOI) * 100;
  const peBarWidth = (analysis.totalPEOI / maxOI) * 100;

  if (chain.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
        <p className="text-xs text-[var(--color-text-muted)]">
          No OI data available
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
      <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
        OI Analysis
      </h3>

      {/* Max Pain */}
      <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-3">
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
          Max Pain
        </div>
        <div className="mt-1 text-xl font-bold text-[var(--color-accent-yellow)]">
          {analysis.maxPainStrike.toLocaleString('en-IN')}
        </div>
        {spotPrice > 0 && (
          <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
            Spot is {spotPrice > analysis.maxPainStrike ? 'above' : 'below'} max pain by{' '}
            {Math.abs(spotPrice - analysis.maxPainStrike).toLocaleString('en-IN')} pts
          </div>
        )}
      </div>

      {/* PCR */}
      <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
              Put/Call Ratio (OI)
            </div>
            <div className="mt-1 text-lg font-bold text-[var(--color-text-primary)]">
              {analysis.pcr.toFixed(2)}
            </div>
          </div>
          <span className={cn('text-xs font-semibold', pcrInterpretation.color)}>
            {pcrInterpretation.text}
          </span>
        </div>
      </div>

      {/* OI Comparison Bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[10px] text-[var(--color-text-muted)]">
          <span>Total CE OI</span>
          <span>Total PE OI</span>
        </div>
        <div className="flex gap-1">
          <div className="flex h-5 flex-1 justify-end overflow-hidden rounded-l bg-[var(--color-bg-tertiary)]">
            <div
              className="h-full rounded-l bg-[var(--color-accent-green)]/30 transition-all duration-500"
              style={{ width: `${ceBarWidth}%` }}
            />
          </div>
          <div className="flex h-5 flex-1 overflow-hidden rounded-r bg-[var(--color-bg-tertiary)]">
            <div
              className="h-full rounded-r bg-[var(--color-accent-red)]/30 transition-all duration-500"
              style={{ width: `${peBarWidth}%` }}
            />
          </div>
        </div>
        <div className="flex items-center justify-between text-xs font-mono">
          <span className="text-[var(--color-accent-green)]">
            {formatLargeNum(analysis.totalCEOI)}
          </span>
          <span className="text-[var(--color-accent-red)]">
            {formatLargeNum(analysis.totalPEOI)}
          </span>
        </div>
      </div>

      {/* Support / Resistance */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-2">
          <div className="text-[10px] text-[var(--color-text-muted)]">
            Resistance (Highest CE OI)
          </div>
          <div className="mt-1 text-sm font-bold text-[var(--color-accent-green)]">
            {analysis.highestCEOIStrike.toLocaleString('en-IN')}
          </div>
        </div>
        <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-2">
          <div className="text-[10px] text-[var(--color-text-muted)]">
            Support (Highest PE OI)
          </div>
          <div className="mt-1 text-sm font-bold text-[var(--color-accent-red)]">
            {analysis.highestPEOIStrike.toLocaleString('en-IN')}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatLargeNum(val: number): string {
  if (val >= 10_000_000) return (val / 10_000_000).toFixed(2) + ' Cr';
  if (val >= 100_000) return (val / 100_000).toFixed(2) + ' L';
  if (val >= 1_000) return (val / 1_000).toFixed(1) + ' K';
  return val.toLocaleString('en-IN');
}
