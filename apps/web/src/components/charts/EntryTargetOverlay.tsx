import { useEffect, useRef } from 'react';
import type { IPriceLine, ISeriesApi } from 'lightweight-charts';

interface EntryTargetOverlayProps {
  series: ISeriesApi<'Candlestick'> | null;
  entry: number | null;
  stoploss: number | null;
  target: number | null;
}

export default function EntryTargetOverlay({
  series,
  entry,
  stoploss,
  target,
}: EntryTargetOverlayProps) {
  const linesRef = useRef<IPriceLine[]>([]);

  useEffect(() => {
    if (!series) return;

    for (const line of linesRef.current) {
      try { series.removePriceLine(line); } catch { /* chart may be disposed */ }
    }
    linesRef.current = [];

    if (entry === null || stoploss === null || target === null) {
      return;
    }

    const fmt = (n: number) =>
      n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const entryLine = series.createPriceLine({
      price: entry,
      color: '#f59e0b',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: `ENTRY ${fmt(entry)}`,
    });
    linesRef.current.push(entryLine);

    const slLine = series.createPriceLine({
      price: stoploss,
      color: '#ef4444',
      lineWidth: 1,
      lineStyle: 0,
      axisLabelVisible: true,
      title: `SL ${fmt(stoploss)}`,
    });
    linesRef.current.push(slLine);

    const tgtLine = series.createPriceLine({
      price: target,
      color: '#10b981',
      lineWidth: 1,
      lineStyle: 0,
      axisLabelVisible: true,
      title: `TGT ${fmt(target)}`,
    });
    linesRef.current.push(tgtLine);

    return () => {
      for (const line of linesRef.current) {
        try { series.removePriceLine(line); } catch { /* ignore */ }
      }
      linesRef.current = [];
    };
  }, [series, entry, stoploss, target]);

  return null;
}
