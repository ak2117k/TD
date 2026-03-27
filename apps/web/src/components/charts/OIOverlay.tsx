import { useEffect, useRef } from 'react';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';

interface OIDataPoint {
  time: number;
  value: number;
}

interface OIOverlayProps {
  chart: IChartApi | null;
  oiData: OIDataPoint[];
  visible: boolean;
}

export default function OIOverlay({ chart, oiData, visible }: OIOverlayProps) {
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  useEffect(() => {
    if (!chart) return;

    const series = chart.addLineSeries({
      color: '#fbbf24',
      lineWidth: 2,
      priceScaleId: 'oi',
      lastValueVisible: true,
      priceLineVisible: false,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
    });

    chart.priceScale('oi').applyOptions({
      scaleMargins: { top: 0.1, bottom: 0.3 },
      drawTicks: false,
      borderVisible: false,
      textColor: '#fbbf24',
    });

    seriesRef.current = series;

    return () => {
      try {
        chart.removeSeries(series);
      } catch {
        // Chart may already be disposed
      }
      seriesRef.current = null;
    };
  }, [chart]);

  // Update data
  useEffect(() => {
    if (!seriesRef.current || oiData.length === 0) return;

    const lineData = oiData.map((d) => ({
      time: d.time as Time,
      value: d.value,
    }));

    seriesRef.current.setData(lineData);
  }, [oiData]);

  // Toggle visibility
  useEffect(() => {
    if (!seriesRef.current) return;
    seriesRef.current.applyOptions({ visible });
  }, [visible]);

  // This component renders no DOM -- it adds a series to the parent chart
  return null;
}
