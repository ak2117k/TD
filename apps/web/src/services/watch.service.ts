import type { WatchEntry, WatchEntryWithEvents, WatchStatus } from '../types/watch.types';

const API_BASE = (import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:4001');

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${text ? ' — ' + text : ''}`);
  }
  return res.json() as Promise<T>;
}

export const watchApi = {
  async list(status?: WatchStatus, limit = 50): Promise<WatchEntry[]> {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    params.set('limit', String(limit));
    return asJson(await fetch(`${API_BASE}/api/watch?${params.toString()}`));
  },

  async get(id: string): Promise<WatchEntryWithEvents> {
    return asJson(await fetch(`${API_BASE}/api/watch/${id}`));
  },

  async execute(id: string, mode: 'paper' | 'live', quantity?: number) {
    return asJson(await fetch(`${API_BASE}/api/watch/${id}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, quantity }),
    }));
  },

  async dismiss(id: string) {
    return asJson(await fetch(`${API_BASE}/api/watch/${id}/dismiss`, { method: 'POST' }));
  },

  async close(id: string, reason: string) {
    return asJson(await fetch(`${API_BASE}/api/watch/${id}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }));
  },
};
