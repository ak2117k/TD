import type { EvidenceKind, EvidenceLevel, LevelCandidate } from '../types/evidence-level.types';

const FLOOR = 35;

interface ScoreOpts {
  /** Adaptive round-number grid for the soft fallback when a side is empty. */
  softRoundGrid: number[];
  floor?: number;
}

interface Cluster {
  price: number;       // strongest contributor's price
  topScore: number;    // for representative price selection
  score: number;       // summed, capped at 100
  kinds: Set<EvidenceKind>;
}

/**
 * Cluster confluent candidates, sum their evidence into a 0–100 score, side
 * them vs the live price, drop everything below the floor, and — when a side
 * has no kept level — surface the nearest adaptive round number on that side as
 * a `soft` fallback (so a blue-sky breakout still shows a "how far" reference).
 */
export function scoreAndCluster(
  candidates: LevelCandidate[],
  ltp: number,
  atr14: number,
  opts: ScoreOpts,
): EvidenceLevel[] {
  if (!(ltp > 0)) return [];
  const floor = opts.floor ?? FLOOR;
  const tol = Math.max(0.3 * atr14, 0.003 * ltp);

  const sorted = [...candidates]
    .filter((c) => Number.isFinite(c.price) && c.price > 0 && c.price !== ltp)
    .sort((a, b) => a.price - b.price);

  const clusters: Cluster[] = [];
  for (const c of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(c.price - last.price) <= tol) {
      last.score = Math.min(100, last.score + c.score);
      last.kinds.add(c.kind);
      if (c.score > last.topScore) {
        last.topScore = c.score;
        last.price = c.price;
      }
    } else {
      clusters.push({ price: c.price, topScore: c.score, score: Math.min(100, c.score), kinds: new Set([c.kind]) });
    }
  }

  const kept: EvidenceLevel[] = clusters
    .filter((cl) => cl.score >= floor)
    .map((cl) => ({
      price: cl.price,
      side: cl.price > ltp ? 'resistance' : 'support',
      score: cl.score,
      kinds: [...cl.kinds],
      soft: false,
      distancePct: ((cl.price - ltp) / ltp) * 100,
    }));

  const hasRes = kept.some((l) => l.side === 'resistance');
  const hasSup = kept.some((l) => l.side === 'support');
  const grid = opts.softRoundGrid.filter((p) => p > 0 && p !== ltp);

  const addSoft = (side: 'resistance' | 'support') => {
    const pool = side === 'resistance' ? grid.filter((p) => p > ltp) : grid.filter((p) => p < ltp);
    if (pool.length === 0) return;
    const price = pool.reduce((best, p) => (Math.abs(p - ltp) < Math.abs(best - ltp) ? p : best));
    kept.push({
      price,
      side,
      score: 0,
      kinds: ['ROUND'],
      soft: true,
      distancePct: ((price - ltp) / ltp) * 100,
    });
  };
  if (!hasRes) addSoft('resistance');
  if (!hasSup) addSoft('support');

  return kept.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct));
}
