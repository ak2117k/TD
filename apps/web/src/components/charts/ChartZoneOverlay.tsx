import { useEffect, useRef } from 'react';
import type { IPriceLine, ISeriesApi } from 'lightweight-charts';
import type { StrongZone } from '@/types';
import { classifyZoneTiers, type ZoneTierAnnotation } from './classifyZoneTiers';

interface ChartZoneOverlayProps {
  candleSeries: ISeriesApi<'Candlestick'> | null;
  zones: StrongZone[];
  /** Live price — required to compute nearest (immediate) walls. */
  ltp: number;
}

interface StyleSpec {
  color: string;
  lineWidth: 1 | 2 | 3;
  // 0 = solid, 2 = dashed (lightweight-charts LineStyle numeric convention).
  lineStyle: 0 | 2;
}

/**
 * Tier drives emphasis; hue always encodes role (red = resistance,
 * green = support). We modulate alpha, never hue.
 *   immediate → solid, 3px, full opacity   (the next wall)
 *   major     → solid, 2px, ~80% opacity    (structural STRONG wall)
 *   context   → dashed, 1px, ~40% opacity   (other MEDIUM levels)
 */
function styleForTier(a: ZoneTierAnnotation): StyleSpec {
  const base = a.zone.type === 'resistance' ? '#ef4444' : '#22c55e';
  if (a.tier === 'immediate') return { color: base, lineWidth: 3, lineStyle: 0 };
  if (a.tier === 'major') return { color: `${base}cc`, lineWidth: 2, lineStyle: 0 };
  return { color: `${base}66`, lineWidth: 1, lineStyle: 2 };
}

/** e.g. "IMM R 2,512 (+0.4%)", "MAJOR S 2,440 (-2.9%)", "R 2,540 (S55)". */
function tierTitle(a: ZoneTierAnnotation): string {
  const role = a.zone.type === 'resistance' ? 'R' : 'S';
  // Swap-aware prefix preserved from the original overlay.
  const flip =
    a.zone.flippedAt && a.zone.wasType
      ? a.zone.wasType === 'support'
        ? 'S→R '
        : 'R→S '
      : '';
  let tag: string;
  if (a.isImmediate && a.isMajor) tag = 'IMM·MAJOR';
  else if (a.isImmediate) tag = 'IMM';
  else if (a.isMajor) tag = 'MAJOR';
  else tag = `S${a.zone.strength}`; // context keeps the strength score
  const priceStr = a.refPrice.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const sign = a.distancePct >= 0 ? '+' : '';
  // For context lines the strength tag already carries info; show distance for
  // immediate/major where it drives the "room to target" judgement.
  const dist =
    a.isImmediate || a.isMajor ? ` (${sign}${a.distancePct.toFixed(1)}%)` : '';
  return `${flip}${tag} ${role} ${priceStr}${dist}`;
}

/**
 * Wrap every lightweight-charts call in try/catch. The library throws
 * "Object is disposed" errors when the chart is torn down mid-cycle (fast
 * unmount, symbol switch, fullscreen toggle, StrictMode double-mount —
 * we have a memory of this exact issue from CandlestickChart.tsx).
 */
function safeCreatePriceLine(
  series: ISeriesApi<'Candlestick'>,
  options: Parameters<ISeriesApi<'Candlestick'>['createPriceLine']>[0],
): IPriceLine | null {
  try {
    return series.createPriceLine(options);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[ChartZoneOverlay] createPriceLine failed (likely disposed):', err);
    return null;
  }
}

function safeRemovePriceLine(
  series: ISeriesApi<'Candlestick'>,
  line: IPriceLine,
): void {
  try {
    series.removePriceLine(line);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[ChartZoneOverlay] removePriceLine failed (likely disposed):', err);
  }
}

/**
 * Renders immediate/major/context S/R as horizontal price lines on the
 * candlestick series. Pure side-effect component — returns null.
 *
 * Each zone draws ONE labeled line at its reachable edge (`refPrice`), plus —
 * for bands (isLine === false) — a thin dashed unlabeled line at the far edge
 * so the band's width is visible. WEAK + straddle zones are dropped by
 * classifyZoneTiers.
 *
 * On every input change we tear down previously-drawn lines and recreate.
 * Cheap (≤ ~20 lines for top 5+5 zones) and avoids stale reconciliation bugs.
 */
export default function ChartZoneOverlay({
  candleSeries,
  zones,
  ltp,
}: ChartZoneOverlayProps) {
  const linesRef = useRef<IPriceLine[]>([]);

  useEffect(() => {
    if (!candleSeries) return;
    const series = candleSeries;

    // 1. Tear down anything drawn previously.
    for (const line of linesRef.current) {
      safeRemovePriceLine(series, line);
    }
    linesRef.current = [];

    // 2. Draw tier-annotated zones.
    const annotations = classifyZoneTiers(zones, ltp);
    for (const a of annotations) {
      const style = styleForTier(a);

      const labeled = safeCreatePriceLine(series, {
        price: a.refPrice,
        color: style.color,
        lineWidth: style.lineWidth,
        lineStyle: style.lineStyle,
        axisLabelVisible: true,
        title: tierTitle(a),
      });
      if (labeled) linesRef.current.push(labeled);

      // Band: draw the far edge thin + dashed + unlabeled to show width.
      if (!a.zone.isLine) {
        const farEdge =
          a.zone.type === 'resistance' ? a.zone.upper : a.zone.lower;
        if (farEdge !== a.refPrice) {
          const edge = safeCreatePriceLine(series, {
            price: farEdge,
            color: `${a.zone.type === 'resistance' ? '#ef4444' : '#22c55e'}66`,
            lineWidth: 1,
            lineStyle: 2, // dashed
            axisLabelVisible: false,
            title: '',
          });
          if (edge) linesRef.current.push(edge);
        }
      }
    }

    // 3. Cleanup on unmount or before the next update.
    return () => {
      for (const line of linesRef.current) {
        safeRemovePriceLine(series, line);
      }
      linesRef.current = [];
    };
  }, [candleSeries, zones, ltp]);

  return null;
}
