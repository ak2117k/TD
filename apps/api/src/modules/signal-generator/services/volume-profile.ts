const NODES_PER_SIDE = 5;

export interface ProfileCandle {
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface VolumeNode {
  price: number;  // bucket center
  volume: number; // total volume in the bucket
  score: number;  // 0–40 volume evidence score
}

/**
 * Volume-by-price profile. Buckets candles by their typical price (v1
 * simplification — assign full bar volume to one bucket, not spread across
 * high–low), scoring each 0–40 by how far it exceeds the average bucket
 * volume (>=3x → ~40). Returns up to NODES_PER_SIDE (5) nodes on EACH side of
 * `ltp` — up to 10 total — selected by descending volume within each side, so
 * the support side is never starved when all heavy volume sits overhead. The
 * average used for scoring stays global (all buckets) so scores remain honest
 * and cross-side comparable. Order: above-side nodes first, then below-side;
 * within a side, descending volume. `scoreAndCluster` re-sorts by price, so
 * callers must not rely on this order.
 *
 * Returns [] for < 10 candles (insufficient profile).
 */
export function computeVolumeNodes(
  candles: ProfileCandle[],
  atr14: number,
  ltp: number,
): VolumeNode[] {
  if (candles.length < 10 || !(ltp > 0)) return [];
  // `ltp > 0` already guarantees a positive bucket; the `!(bucket > 0)` guard
  // remains only to reject a NaN bucket from a NaN atr14 (Math.max propagates NaN).
  const bucket = Math.max(0.1 * atr14, 0.0025 * ltp);
  if (!(bucket > 0)) return [];

  const byBucket = new Map<number, number>(); // bucketIndex → volume
  for (const k of candles) {
    const typical = (k.high + k.low + k.close) / 3;
    const idx = Math.round(typical / bucket);
    const vol = Number(k.volume) || 0;
    byBucket.set(idx, (byBucket.get(idx) ?? 0) + vol);
  }
  if (byBucket.size === 0) return [];

  const totalVol = [...byBucket.values()].reduce((a, b) => a + b, 0);
  const avgVol = totalVol / byBucket.size;

  const nodes: VolumeNode[] = [...byBucket.entries()].map(([idx, volume]) => ({
    price: idx * bucket,
    volume,
    score: avgVol > 0 ? 40 * Math.min(volume / avgVol / 3, 1) : 0,
  }));

  // Select the strongest nodes on EACH side of the live price, not the global
  // top-N. Volume is the biggest single evidence contributor; when price sits
  // low in its range every heavy-volume bucket is overhead, which would starve
  // the support side. `avgVol` above stays global so scores remain honest and
  // cross-side comparable — a small support node still scores low.
  const byVolumeDesc = (a: VolumeNode, b: VolumeNode) => b.volume - a.volume;
  const above = nodes.filter((n) => n.price > ltp).sort(byVolumeDesc).slice(0, NODES_PER_SIDE);
  const below = nodes.filter((n) => n.price < ltp).sort(byVolumeDesc).slice(0, NODES_PER_SIDE);
  return [...above, ...below];
}
