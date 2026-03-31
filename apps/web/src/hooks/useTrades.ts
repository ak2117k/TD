import { useEffect, useRef } from 'react';
import { wsService } from '@/services/websocket';
import { useTradeStore } from '@/stores/trade-store';
import type { TradeEvent, Position, RiskStatus } from '@/types';

export function useTrades() {
  const openTrades = useTradeStore((s) => s.openTrades);
  const positions = useTradeStore((s) => s.positions);
  const riskStatus = useTradeStore((s) => s.riskStatus);
  const recentTrades = useTradeStore((s) => s.recentTrades);
  const executionLog = useTradeStore((s) => s.executionLog);
  const isLoading = useTradeStore((s) => s.isLoading);
  const fetchOpenTrades = useTradeStore((s) => s.fetchOpenTrades);
  const fetchPositions = useTradeStore((s) => s.fetchPositions);
  const fetchRiskStatus = useTradeStore((s) => s.fetchRiskStatus);
  const addTradeEvent = useTradeStore((s) => s.addTradeEvent);
  const updatePosition = useTradeStore((s) => s.updatePosition);
  const setRiskStatus = useTradeStore((s) => s.setRiskStatus);
  const setOpenTrades = useTradeStore((s) => s.setOpenTrades);
  const setKillSwitchActive = useTradeStore((s) => s.setKillSwitchActive);

  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    fetchOpenTrades();
    fetchPositions();
    fetchRiskStatus();

    // Auto-refresh positions every 5 seconds
    intervalRef.current = setInterval(() => {
      fetchPositions();
    }, 5000);

    return () => {
      clearInterval(intervalRef.current);
    };
  }, [fetchOpenTrades, fetchPositions, fetchRiskStatus]);

  useEffect(() => {
    wsService.connect();

    const unsubTrade = wsService.subscribe('trade-update', (data) => {
      const event = data as TradeEvent;
      addTradeEvent(event);

      // If a trade was closed, refresh open trades
      if (event.eventType === 'CLOSED' || event.eventType === 'SL_HIT' || event.eventType === 'TARGET_HIT') {
        fetchOpenTrades();
      }
    });

    const unsubPosition = wsService.subscribe('position-update', (data) => {
      updatePosition(data as Position);
    });

    const unsubRisk = wsService.subscribe('risk-status', (data) => {
      setRiskStatus(data as RiskStatus);
    });

    const unsubKill = wsService.subscribe('kill-switch-activated', () => {
      setKillSwitchActive(true);
      setOpenTrades([]);
      setTimeout(() => setKillSwitchActive(false), 3000);
    });

    return () => {
      unsubTrade();
      unsubPosition();
      unsubRisk();
      unsubKill();
    };
  }, [addTradeEvent, updatePosition, setRiskStatus, setOpenTrades, setKillSwitchActive, fetchOpenTrades]);

  return {
    openTrades,
    positions,
    riskStatus,
    recentTrades,
    executionLog,
    isLoading,
  };
}
