import { useEffect, useRef } from 'react';
import { wsService } from '@/services/websocket';
import { useAutoTradeStore } from '@/stores/auto-trade-store';
import toast from 'react-hot-toast';

export function useAutoTrade() {
  const {
    status,
    pendingApprovals,
    isLoading,
    fetchStatus,
    fetchPendingApprovals,
    approveSignal,
    rejectSignal,
    forceExecute,
    triggerScan,
    addPendingApproval,
    removePendingApproval,
    setStatus,
  } = useAutoTradeStore();

  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    fetchStatus();
    fetchPendingApprovals();

    // Auto-refresh status every 10 seconds
    intervalRef.current = setInterval(() => {
      fetchStatus();
    }, 10000);

    return () => {
      clearInterval(intervalRef.current);
    };
  }, [fetchStatus, fetchPendingApprovals]);

  useEffect(() => {
    wsService.connect();

    const unsubPending = wsService.subscribe('auto-trade:pending-approval', (data) => {
      addPendingApproval(data as Parameters<typeof addPendingApproval>[0]);
    });

    const unsubApproved = wsService.subscribe('auto-trade:signal-approved', (data) => {
      const { signalId } = data as { signalId: string };
      removePendingApproval(signalId);
      toast.success('Signal approved');
    });

    const unsubRejected = wsService.subscribe('auto-trade:signal-rejected', (data) => {
      const { signalId } = data as { signalId: string };
      removePendingApproval(signalId);
    });

    const unsubExecuted = wsService.subscribe('auto-trade:executed', (data) => {
      const { symbol } = data as { symbol: string };
      toast.success(`Trade executed: ${symbol}`);
    });

    const unsubScanComplete = wsService.subscribe('auto-trade:scan-complete', () => {
      fetchStatus();
    });

    const unsubError = wsService.subscribe('auto-trade:error', (data) => {
      const { message } = data as { message: string };
      toast.error(message);
    });

    return () => {
      unsubPending();
      unsubApproved();
      unsubRejected();
      unsubExecuted();
      unsubScanComplete();
      unsubError();
    };
  }, [addPendingApproval, removePendingApproval, fetchStatus]);

  return {
    status,
    pendingApprovals,
    isLoading,
    approveSignal,
    rejectSignal,
    forceExecute,
    triggerScan,
    setStatus,
  };
}
