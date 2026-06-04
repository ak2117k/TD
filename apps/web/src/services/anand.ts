import api from './api';

export interface AnandEntry {
  id: string;
  symbol: string;
  token: string | null;
  entryPrice: number;
  enteredAt: string;
  targetPct: number;
  stopPct: number;
  status: string;
  exitPrice: number | null;
  exitedAt: string | null;
  currentPrice: number;
  pnlPct: number;
  targetLeftPct: number;
  scannerName: string | null;   // resolved from alertId on the backend
  scoreBreakdown: Array<{ name: string; points: number; pointsPossible: number; passed: boolean }> | null;
}

export interface PnlPeriod {
  avgExitPct: number;
  count: number;
  winCount: number;
  totalPnlRs: number;
}

export interface PnlSummary {
  daily: PnlPeriod;
  weekly: PnlPeriod;
  monthly: PnlPeriod;
  yearly: PnlPeriod;
}

export async function listIntradayEntries(params: {
  status?: string; from?: string; to?: string;
} = {}): Promise<AnandEntry[]> {
  const r = await api.get<AnandEntry[]>('/anand/intraday/entries', { params });
  return r.data;
}

export async function listSwingEntries(params: {
  status?: string; from?: string; to?: string;
} = {}): Promise<AnandEntry[]> {
  const r = await api.get<AnandEntry[]>('/anand/swing/entries', { params });
  return r.data;
}

export async function getIntradayPnl(): Promise<PnlSummary> {
  const r = await api.get<PnlSummary>('/anand/intraday/pnl-summary');
  return r.data;
}

export async function getSwingPnl(): Promise<PnlSummary> {
  const r = await api.get<PnlSummary>('/anand/swing/pnl-summary');
  return r.data;
}
