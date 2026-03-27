import { create } from 'zustand';
import type { TradeSignal, SignalConfidence, Segment } from '@/types';
import api from '@/services/api';

export interface SignalFilters {
  strategy: string;
  segment: string;
  minConfidence: string;
  isActive: boolean;
  sortBy: 'confidence' | 'time' | 'riskReward';
}

interface SignalState {
  signals: TradeSignal[];
  filters: SignalFilters;
  isLoading: boolean;
  isScanRunning: boolean;
  newSignalIds: Set<string>;

  fetchSignals: () => Promise<void>;
  addSignal: (signal: TradeSignal) => void;
  removeSignal: (id: string) => void;
  updateFilters: (partial: Partial<SignalFilters>) => void;
  triggerScan: () => Promise<void>;
  clearNewFlag: (id: string) => void;
}

const CONFIDENCE_ORDER: Record<string, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  VERY_HIGH: 4,
};

function matchesMinConfidence(
  confidence: SignalConfidence,
  min: string,
): boolean {
  if (min === 'all') return true;
  const level = CONFIDENCE_ORDER[confidence] ?? 0;
  const minLevel = CONFIDENCE_ORDER[min] ?? 0;
  return level >= minLevel;
}

export const useSignalStore = create<SignalState>((set, get) => ({
  signals: [],
  filters: {
    strategy: 'all',
    segment: 'all',
    minConfidence: 'all',
    isActive: true,
    sortBy: 'confidence',
  },
  isLoading: false,
  isScanRunning: false,
  newSignalIds: new Set(),

  fetchSignals: async () => {
    set({ isLoading: true });
    try {
      const res = await api.get('/signals/active');
      const signals: TradeSignal[] = (res.data?.data ?? res.data ?? []).map(
        (s: TradeSignal) => ({
          ...s,
          createdAt: new Date(s.createdAt),
        }),
      );
      set({ signals, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  addSignal: (signal) => {
    set((state) => {
      const exists = state.signals.some((s) => s.id === signal.id);
      if (exists) return state;
      const newIds = new Set(state.newSignalIds);
      newIds.add(signal.id);
      return {
        signals: [
          { ...signal, createdAt: new Date(signal.createdAt) },
          ...state.signals,
        ],
        newSignalIds: newIds,
      };
    });
  },

  removeSignal: (id) => {
    set((state) => ({
      signals: state.signals.filter((s) => s.id !== id),
    }));
  },

  updateFilters: (partial) => {
    set((state) => ({
      filters: { ...state.filters, ...partial },
    }));
  },

  triggerScan: async () => {
    set({ isScanRunning: true });
    try {
      await api.post('/signals/scan');
      await get().fetchSignals();
    } finally {
      set({ isScanRunning: false });
    }
  },

  clearNewFlag: (id) => {
    set((state) => {
      const newIds = new Set(state.newSignalIds);
      newIds.delete(id);
      return { newSignalIds: newIds };
    });
  },
}));

// Selectors
export function selectFilteredSignals(state: SignalState): TradeSignal[] {
  const { signals, filters } = state;

  let filtered = signals.filter((s) => {
    if (filters.strategy !== 'all' && s.strategy !== filters.strategy)
      return false;
    if (
      filters.segment !== 'all' &&
      s.segment !== (filters.segment as Segment)
    )
      return false;
    if (!matchesMinConfidence(s.confidence, filters.minConfidence))
      return false;
    return true;
  });

  // Sort
  filtered = [...filtered].sort((a, b) => {
    switch (filters.sortBy) {
      case 'confidence':
        return b.confidenceScore - a.confidenceScore;
      case 'time':
        return (
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      case 'riskReward':
        return b.riskRewardRatio - a.riskRewardRatio;
      default:
        return 0;
    }
  });

  return filtered;
}

export function selectActiveCount(state: SignalState): number {
  return state.signals.length;
}

export function selectAvgConfidence(state: SignalState): number {
  if (state.signals.length === 0) return 0;
  const sum = state.signals.reduce((acc, s) => acc + s.confidenceScore, 0);
  return Math.round(sum / state.signals.length);
}
