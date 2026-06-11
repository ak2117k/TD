export interface PivotCandle {
  high: number;
  low: number;
}

export interface SwingPivot {
  price: number;
  kind: 'high' | 'low';
}

/**
 * Standalone 3-bar fractal swing-pivot detector. Mirrors the proven rule
 * inside StrongZoneDetectorService.detectPivots: index `i` is a swing high
 * when its high strictly exceeds the highs of the 3 bars on either side, and
 * a swing low when its low is strictly below the lows of the 3 bars on either
 * side. The first and last 3 bars are skipped (edges can't be confirmed).
 *
 * Used to derive evidence HISTORY candidates from per-timeframe candles on
 * non-15m intervals (the 15m path keeps using the DB-stored zone pivots).
 */
export function detectSwingPivots(candles: PivotCandle[]): SwingPivot[] {
  const pivots: SwingPivot[] = [];
  if (!Array.isArray(candles)) return pivots;

  for (let i = 3; i < candles.length - 3; i++) {
    const c = candles[i];
    const isHigh =
      c.high > candles[i - 1].high &&
      c.high > candles[i - 2].high &&
      c.high > candles[i - 3].high &&
      c.high > candles[i + 1].high &&
      c.high > candles[i + 2].high &&
      c.high > candles[i + 3].high;
    if (isHigh) {
      pivots.push({ price: c.high, kind: 'high' });
      continue;
    }
    const isLow =
      c.low < candles[i - 1].low &&
      c.low < candles[i - 2].low &&
      c.low < candles[i - 3].low &&
      c.low < candles[i + 1].low &&
      c.low < candles[i + 2].low &&
      c.low < candles[i + 3].low;
    if (isLow) {
      pivots.push({ price: c.low, kind: 'low' });
    }
  }
  return pivots;
}
