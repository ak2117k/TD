import { useEffect, useRef, useCallback } from 'react';
import {
  useSignalStore,
  selectFilteredSignals,
  selectActiveCount,
  selectAvgConfidence,
} from '@/stores/signal-store';
import { wsService } from '@/services/websocket';
import type { TradeSignal } from '@/types';

const REFRESH_INTERVAL = 30_000;

export function useSignals() {
  const fetchSignals = useSignalStore((s) => s.fetchSignals);
  const addSignal = useSignalStore((s) => s.addSignal);
  const removeSignal = useSignalStore((s) => s.removeSignal);
  const triggerScan = useSignalStore((s) => s.triggerScan);
  const isLoading = useSignalStore((s) => s.isLoading);
  const isScanRunning = useSignalStore((s) => s.isScanRunning);
  const signals = useSignalStore(selectFilteredSignals);
  const activeCount = useSignalStore(selectActiveCount);
  const avgConfidence = useSignalStore(selectAvgConfidence);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchSignals();

    // Auto-refresh
    intervalRef.current = setInterval(fetchSignals, REFRESH_INTERVAL);

    // WebSocket subscriptions
    const unsubNew = wsService.subscribe('signal', (data) => {
      const payload = data as { type?: string; signal?: TradeSignal; signalId?: string };
      if (payload.type === 'new-signal' && payload.signal) {
        addSignal(payload.signal);
      } else if (payload.type === 'signal-expired' && payload.signalId) {
        removeSignal(payload.signalId);
      } else if (payload.signal) {
        // Fallback: treat any signal event with a signal payload as new
        addSignal(payload.signal);
      }
    });

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      unsubNew();
    };
  }, [fetchSignals, addSignal, removeSignal]);

  const handleTriggerScan = useCallback(() => {
    triggerScan();
  }, [triggerScan]);

  return {
    signals,
    activeCount,
    avgConfidence,
    isLoading,
    isScanRunning,
    triggerScan: handleTriggerScan,
  };
}
