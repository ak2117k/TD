import { useEffect, useRef } from 'react';
import type { IPriceLine, ISeriesApi } from 'lightweight-charts';
import type { StrongZone } from '@/types';

interface ChartZoneOverlayProps {
  candleSeries: ISeriesApi<'Candlestick'> | null;
  zones: StrongZone[];
}

interface StyleSpec {
  color: string;
  lineWidth: 1 | 2;
  // numeric lightweight-charts LineStyle: 0=solid, 1=dotted, 2=dashed,
  // 3=large-dashed, 4=sparse-dotted. Matches LevelOverlay/EntryTargetOverlay
  // convention used elsewhere in this codebase.
  lineStyle: 0 | 2;
}

/**
 * Pick stroke colour + weight + dash pattern per the design spec.
 * Returns null for WEAK zones — caller should skip rendering them.
 */
function styleFor(zone: StrongZone): StyleSpec | null {
  if (zone.classification === 'WEAK') return null;

  const isResistance = zone.type === 'resistance';
  if (zone.classification === 'STRONG') {
    return {
      color: isResistance ? '#ef4444' : '#22c55e',
      lineWidth: 2,
      lineStyle: 0, // solid
    };
  }
  // MEDIUM
  return {
    color: isResistance ? '#f97316' : '#3b82f6',
    lineWidth: 1,
    lineStyle: 2, // dashed
  };
}

/** "R 24,750.5 (S87)" or "S 24,500 (S72)" — Indian-locale grouping. */
function formatTitle(zone: StrongZone, price: number): string {
  // Swap-aware prefix: when a zone has flipped polarity (impulsive break
  // beyond the wall — see backend StrongZoneDetectorService), surface
  // the "S→R" / "R→S" transition so a trader can tell at a glance that
  // this band is a former-S/R that has been broken and is now acting in
  // the opposite role. Falls back to plain "S" / "R" for original zones.
  const prefix = zone.flippedAt && zone.wasType
    ? (zone.wasType === 'support' ? 'S→R' : 'R→S')
    : (zone.type === 'resistance' ? 'R' : 'S');
  const priceStr = price.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return `${prefix} ${priceStr} (S${zone.strength})`;
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
 * Renders strong support/resistance zones as horizontal price lines on the
 * candlestick series. Pure side-effect component — returns null.
 *
 * - `isLine: true`  → ONE line at (upper+lower)/2.
 * - `isLine: false` → TWO lines (upper + lower edges) drawn dashed so the
 *   user sees the band's edges without us needing a custom canvas overlay.
 *   Acceptable simplification per the spec — flagged in the agent report.
 * - WEAK zones are skipped to avoid visual noise.
 *
 * On every `zones` update we tear down the previously-drawn lines and
 * recreate. Cheap (<= ~20 lines for top 5+5 zones) and avoids stale-state
 * reconciliation bugs.
 */
export default function ChartZoneOverlay({
  candleSeries,
  zones,
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

    // 2. Draw the new zones.
    for (const zone of zones) {
      const style = styleFor(zone);
      if (!style) continue; // WEAK — skip

      if (zone.isLine) {
        // Single horizontal line at the zone center.
        const center = (zone.upper + zone.lower) / 2;
        const line = safeCreatePriceLine(series, {
          price: center,
          color: style.color,
          lineWidth: style.lineWidth,
          lineStyle: style.lineStyle,
          axisLabelVisible: true,
          title: formatTitle(zone, center),
        });
        if (line) linesRef.current.push(line);
      } else {
        // Band — draw upper + lower edges. Inner edges are dashed so a
        // viewer can see this is a band rather than two unrelated lines.
        // Title only on the outer edge to keep the axis legend tidy.
        const upperLine = safeCreatePriceLine(series, {
          price: zone.upper,
          color: style.color,
          lineWidth: style.lineWidth,
          lineStyle: 2, // dashed inner edge
          axisLabelVisible: true,
          title:
            zone.type === 'resistance'
              ? formatTitle(zone, zone.upper) // resistance: label upper edge
              : '',
        });
        if (upperLine) linesRef.current.push(upperLine);

        const lowerLine = safeCreatePriceLine(series, {
          price: zone.lower,
          color: style.color,
          lineWidth: style.lineWidth,
          lineStyle: 2,
          axisLabelVisible: true,
          title:
            zone.type === 'support'
              ? formatTitle(zone, zone.lower) // support: label lower edge
              : '',
        });
        if (lowerLine) linesRef.current.push(lowerLine);
      }
    }

    // 3. Cleanup on unmount or before the next zones update.
    return () => {
      for (const line of linesRef.current) {
        safeRemovePriceLine(series, line);
      }
      linesRef.current = [];
    };
  }, [candleSeries, zones]);

  return null;
}
