import { useEffect, useRef } from 'react';
import { wsService } from '@/services/websocket';
import { useTradeStore } from '@/stores/trade-store';
import type { Trade, TradeEvent, Position, RiskStatus } from '@/types';

export function useTrades() {
  const {
    openTrades,
    positions,
    riskStatus,
    recentTrades,
    executionLog,
    isLoading,
    fetchOpenTrades,
    fetchPositions,
    fetchRiskStatus,
    addTradeEvent,
    updatePosition,
    setRiskStatus,
    setOpenTrades,
    setKillSwitchActive,
  } = useTradeStore();

  const intervalRef = useRef<ReturnType<typeof setInterval>>();

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
