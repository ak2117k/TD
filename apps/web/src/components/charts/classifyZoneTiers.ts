import type { StrongZone } from '@/types';

export type ZoneTier = 'immediate' | 'major' | 'context';

export interface ZoneTierAnnotation {
  zone: StrongZone;
  tier: ZoneTier;
  /** True when this is the nearest drawable zone on its side of the LTP. */
  isImmediate: boolean;
  /** True when this is the nearest STRONG zone on its side of the LTP. */
  isMajor: boolean;
  /** The band edge price reaches first coming from the LTP (== center for lines). */
  refPrice: number;
  /** Signed % distance from LTP. + = above price, - = below. */
  distancePct: number;
}

/** The band edge a mover reaches first coming from the LTP side. */
function refPriceFor(zone: StrongZone): number {
  if (zone.isLine) return zone.upper; // upper === lower for a line
  // Resistance sits above price → its LOWER edge is hit first.
  // Support sits below price → its UPPER edge is hit first.
  return zone.type === 'resistance' ? zone.lower : zone.upper;
}

/**
 * Annotate strong zones into two trader tiers relative to the live price:
 *  - immediate = nearest drawable (non-WEAK) zone on each side (the next wall)
 *  - major     = nearest STRONG zone on each side (the structural wall)
 * A zone can be both (nearest is STRONG) — `tier` is 'immediate' but
 * `isMajor` is also true so the renderer can tag it `IMM·MAJOR`.
 *
 * WEAK zones are dropped (never drawn, too unreliable to call a "wall").
 * Returns [] when ltp is not a positive number.
 */
export function classifyZoneTiers(
  zones: StrongZone[],
  ltp: number,
): ZoneTierAnnotation[] {
  if (!Number.isFinite(ltp) || ltp <= 0) return [];

  // Drop WEAK (never drawn) and straddle zones — a band whose range contains
  // the LTP can't be cleanly sided into above/below, and its reachable-edge
  // refPrice would contradict its type. Lines (isLine) never straddle.
  const drawable = zones.filter(
    (z) =>
      z.classification !== 'WEAK' &&
      (z.isLine || z.lower > ltp || z.upper < ltp),
  );

  const above: StrongZone[] = [];
  const below: StrongZone[] = [];
  for (const z of drawable) {
    const ref = refPriceFor(z);
    if (ref > ltp) above.push(z);
    else below.push(z); // ref <= ltp → treat as support side deterministically
  }

  const annotateSide = (side: StrongZone[]): ZoneTierAnnotation[] => {
    if (side.length === 0) return [];
    type Row = {
      zone: StrongZone;
      refPrice: number;
      distancePct: number;
      absDist: number; // sort-only; never returned
    };
    const rows: Row[] = side.map((zone) => {
      const refPrice = refPriceFor(zone);
      return {
        zone,
        refPrice,
        distancePct: ((refPrice - ltp) / ltp) * 100,
        absDist: Math.abs(refPrice - ltp),
      };
    });

    // Nearest wins `immediate`. Strict `<` means ties are won by the
    // first-in-input-array zone; the equidistant other falls to major/context.
    let nearestIdx = 0;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].absDist < rows[nearestIdx].absDist) nearestIdx = i;
    }

    let strongIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].zone.classification !== 'STRONG') continue;
      if (strongIdx === -1 || rows[i].absDist < rows[strongIdx].absDist) {
        strongIdx = i;
      }
    }

    return rows.map((d, i) => {
      const isImmediate = i === nearestIdx;
      const isMajor = i === strongIdx;
      const tier: ZoneTier = isImmediate
        ? 'immediate'
        : isMajor
          ? 'major'
          : 'context';
      return {
        zone: d.zone,
        tier,
        isImmediate,
        isMajor,
        refPrice: d.refPrice,
        distancePct: d.distancePct,
      };
    });
  };

  return [...annotateSide(above), ...annotateSide(below)];
}
