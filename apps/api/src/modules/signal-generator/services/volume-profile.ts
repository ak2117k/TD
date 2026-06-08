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
 * high–low), returns the top 5 high-volume nodes scored 0–40 by how far each
 * exceeds the average bucket volume (>=3x → ~40).
 *
 * Returns [] for < 10 candles (insufficient profile).
 */
export function computeVolumeNodes(
  candles: ProfileCandle[],
  atr14: number,
  ltp: number,
): VolumeNode[] {
  if (candles.length < 10 || !(ltp > 0)) return [];
  const bucket = Math.max(0.1 * atr14, 0.0025 * ltp) || 0.0025 * ltp;
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

  nodes.sort((a, b) => b.volume - a.volume);
  return nodes.slice(0, 5);
}
