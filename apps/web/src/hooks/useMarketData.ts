import { useEffect } from 'react';
import { wsService } from '@/services/websocket';
import { useMarketStore } from '@/stores/market-store';
import type { Quote } from '@/types';

export function useMarketData(): void {
  const updateQuote = useMarketStore((s) => s.updateQuote);
  const setConnected = useMarketStore((s) => s.setConnected);

  useEffect(() => {
    wsService.connect();

    const unsubTick = wsService.subscribe('tick', (data) => {
      updateQuote(data as Quote);
    });

    const unsubConn = wsService.subscribe('connection-status', (data) => {
      const { connected } = data as { connected: boolean };
      setConnected(connected);
    });

    return () => {
      unsubTick();
      unsubConn();
    };
  }, [updateQuote, setConnected]);
}
