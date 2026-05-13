import { useEffect, useState, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';
import { watchApi } from '../services/watch.service';
import type { WatchEntry, WatchStatus } from '../types/watch.types';

const API_BASE = (import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:4001');

export function useWatchEntries(status?: WatchStatus) {
  const [entries, setEntries] = useState<WatchEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await watchApi.list(status);
      setEntries(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { refetch(); }, [refetch]);

  useEffect(() => {
    const socket: Socket = io(`${API_BASE}/watch`, { transports: ['websocket'] });
    let tickDebounce: ReturnType<typeof setTimeout> | null = null;
    const debouncedRefetch = () => {
      if (tickDebounce) clearTimeout(tickDebounce);
      tickDebounce = setTimeout(() => { refetch(); }, 1000);
    };
    const onTick = () => { debouncedRefetch(); };
    const onEvent = () => { refetch(); };
    const onCreated = () => { refetch(); };
    socket.on('watch:tick', onTick);
    socket.on('watch:event', onEvent);
    socket.on('watch:created', onCreated);
    return () => {
      socket.off('watch:tick', onTick);
      socket.off('watch:event', onEvent);
      socket.off('watch:created', onCreated);
      if (tickDebounce) clearTimeout(tickDebounce);
      socket.disconnect();
    };
  }, [refetch]);

  return { entries, loading, error, refetch };
}
