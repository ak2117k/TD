import { useEffect, useState } from 'react';
import { listUngatedEntries } from '../services/ungatedWatch';
import type { UngatedWatchEntry } from '../types/ungatedWatch.types';
import type { WatchStatus } from '../types/watch.types';

export function useUngatedWatchEntries(filter?: WatchStatus, date?: string) {
  const [entries, setEntries] = useState<UngatedWatchEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLoading(true);
    listUngatedEntries({ status: filter, date })
      .then((data) => { setEntries(data); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [filter, date]);
  return { entries, loading, error };
}
