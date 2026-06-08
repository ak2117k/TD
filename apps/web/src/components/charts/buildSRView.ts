import type { StrongZone } from '@/types';

export type SRSource = 'PDH' | 'PDL' | 'ORH' | 'ORL' | 'VWAP' | 'PIVOT';
export type SRTier = 'immediate' | 'major' | 'context';

export interface SRLevel {
  price: number;
  side: 'resistance' | 'support';
  source: SRSource;
  label: string;
  tier: SRTier;
  distancePct: number;
  classification?: 'STRONG' | 'MEDIUM' | 'WEAK';
}

export interface SRView {
  immediateResistance: SRLevel | null;
  immediateSupport: SRLevel | null;
  levels: SRLevel[];
}

/** Minimal level-book shape (structurally satisfied by AnalysisDto.levels). */
export interface LevelBookLite {
  pdh: number | null;
  pdl: number | null;
  orh: number | null;
  orl: number | null;
  prevOrh?: number | null;
  prevOrl?: number | null;
  vwap: number;
}

const DEDUPE_EPS_PCT = 0.05; // 0.05% — treat anchored & pivot within this as one

/** Pivot reachable edge: resistance hits its lower edge first, support its upper. */
function pivotRefPrice(z: StrongZone): number {
  if (z.isLine) return z.upper;
  return z.type === 'resistance' ? z.lower : z.upper;
}

interface Candidate {
  price: number;
  source: SRSource;
  label: string;
  isStructural: boolean; // STRONG pivot, or PDH/PDL — eligible for `major`
  classification?: 'STRONG' | 'MEDIUM' | 'WEAK';
}

export function buildSRView(
  book: LevelBookLite | null,
  zones: StrongZone[],
  ltp: number,
): SRView {
  if (!Number.isFinite(ltp) || ltp <= 0) {
    return { immediateResistance: null, immediateSupport: null, levels: [] };
  }

  const candidates: Candidate[] = [];

  if (book) {
    const push = (price: number | null | undefined, source: SRSource, label: string, structural: boolean) => {
      if (price != null && price > 0) candidates.push({ price, source, label, isStructural: structural });
    };
    push(book.pdh, 'PDH', 'PDH', true);
    push(book.pdl, 'PDL', 'PDL', true);
    push(book.orh ?? book.prevOrh, 'ORH', 'ORH', false);
    push(book.orl ?? book.prevOrl, 'ORL', 'ORL', false);
    if (book.vwap > 0) push(book.vwap, 'VWAP', 'VWAP', false);
  }

  for (const z of zones) {
    const isForming = z.flippedAt != null;
    if (z.classification === 'WEAK' && !isForming) continue;
    candidates.push({
      price: pivotRefPrice(z),
      source: 'PIVOT',
      label: `S${z.strength}`,
      isStructural: z.classification === 'STRONG',
      classification: z.classification,
    });
  }

  const above: Candidate[] = [];
  const below: Candidate[] = [];
  for (const c of candidates) {
    if (c.price > ltp) above.push(c);
    else if (c.price < ltp) below.push(c);
  }

  const dedupe = (arr: Candidate[]): Candidate[] => {
    const sorted = [...arr].sort((a, b) => {
      const d = Math.abs(a.price - ltp) - Math.abs(b.price - ltp);
      if (d !== 0) return d;
      return (a.source === 'PIVOT' ? 1 : 0) - (b.source === 'PIVOT' ? 1 : 0);
    });
    const kept: Candidate[] = [];
    for (const c of sorted) {
      const eps = (ltp * DEDUPE_EPS_PCT) / 100;
      if (kept.some((k) => Math.abs(k.price - c.price) <= eps)) continue;
      kept.push(c);
    }
    return kept;
  };
  const aboveKept = dedupe(above);
  const belowKept = dedupe(below);

  const toLevel = (
    c: Candidate,
    side: 'resistance' | 'support',
    isImmediate: boolean,
  ): SRLevel => {
    const tier: SRTier = isImmediate ? 'immediate' : c.isStructural ? 'major' : 'context';
    return {
      price: c.price,
      side,
      source: c.source,
      label: c.label,
      tier,
      distancePct: ((c.price - ltp) / ltp) * 100,
      classification: c.classification,
    };
  };

  const resLevels = aboveKept.map((c, i) => toLevel(c, 'resistance', i === 0));
  const supLevels = belowKept.map((c, i) => toLevel(c, 'support', i === 0));

  return {
    immediateResistance: resLevels[0] ?? null,
    immediateSupport: supLevels[0] ?? null,
    levels: [...resLevels, ...supLevels],
  };
}
