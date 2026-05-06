import api from './api';
import type { ChartinkScanner, ChartinkAlert } from '@/types';

export async function listScanners(): Promise<ChartinkScanner[]> {
  const r = await api.get<ChartinkScanner[]>('/chartink/scanners');
  return r.data;
}

export async function listAlerts(limit = 50): Promise<ChartinkAlert[]> {
  const r = await api.get<ChartinkAlert[]>('/chartink/alerts', { params: { limit } });
  return r.data;
}

export async function getAlert(id: string): Promise<ChartinkAlert> {
  const r = await api.get<ChartinkAlert>(`/chartink/alerts/${id}`);
  return r.data;
}
