import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:4001';

export interface PaperAccount {
  startingCapital: number;
  balance: number;
  deployedCapital: number;
  unrealizedPnl: number;
  equity: number;
  openPositions: number;
}

export function usePaperAccount(pollMs = 5000) {
  const [account, setAccount] = useState<PaperAccount | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const fetchOnce = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/trades/paper-account`);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = (await res.json()) as PaperAccount;
        if (alive) {
          setAccount(data);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pollMs]);

  return { account, error };
}
