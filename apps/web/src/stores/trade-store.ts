import { create } from 'zustand';
import type { Trade, TradeEvent, RiskStatus } from '@/types';
import type { Position } from '@/types';
import api from '@/services/api';
import toast from 'react-hot-toast';

interface TradeState {
  openTrades: Trade[];
  positions: Position[];
  recentTrades: Trade[];
  executionLog: TradeEvent[];
  riskStatus: RiskStatus;
  isKillSwitchActive: boolean;
  isLoading: boolean;

  fetchOpenTrades: () => Promise<void>;
  fetchPositions: () => Promise<void>;
  fetchRiskStatus: () => Promise<void>;
  executeTrade: (dto: Record<string, unknown>) => Promise<void>;
  closeTrade: (id: string) => Promise<void>;
  closeAllPositions: () => Promise<void>;
  addTradeEvent: (event: TradeEvent) => void;
  updatePosition: (position: Position) => void;
  setOpenTrades: (trades: Trade[]) => void;
  setPositions: (positions: Position[]) => void;
  setRiskStatus: (status: RiskStatus) => void;
  setKillSwitchActive: (active: boolean) => void;
}

const defaultRiskStatus: RiskStatus = {
  dailyLossUsed: 0,
  dailyLossLimit: 5000,
  positionsUsed: 0,
  positionsLimit: 5,
  capitalDeployed: 0,
  capitalLimit: 100000,
};

export const useTradeStore = create<TradeState>((set) => ({
  openTrades: [],
  positions: [],
  recentTrades: [],
  executionLog: [],
  riskStatus: defaultRiskStatus,
  isKillSwitchActive: false,
  isLoading: false,

  fetchOpenTrades: async () => {
    try {
      const { data } = await api.get<Trade[]>('/trades/open');
      set({ openTrades: data });
    } catch {
      console.warn('Failed to fetch open trades');
    }
  },

  fetchPositions: async () => {
    try {
      const { data } = await api.get<Position[]>('/trades/positions');
      set({ positions: data });
    } catch {
      console.warn('Failed to fetch positions');
    }
  },

  fetchRiskStatus: async () => {
    try {
      const { data } = await api.get<RiskStatus>('/trades/risk-status');
      set({ riskStatus: data });
    } catch {
      console.warn('Failed to fetch risk status');
    }
  },

  executeTrade: async (dto) => {
    set({ isLoading: true });
    try {
      const { data } = await api.post<Trade>('/trades/execute', dto);
      set((state) => ({
        openTrades: [data, ...state.openTrades],
      }));
      toast.success(`Trade executed: ${dto.side} ${dto.symbol}`);
    } catch (err) {
      toast.error('Trade execution failed');
      throw err;
    } finally {
      set({ isLoading: false });
    }
  },

  closeTrade: async (id) => {
    try {
      const { data } = await api.post<Trade>(`/trades/${id}/close`);
      set((state) => ({
        openTrades: state.openTrades.filter((t) => t.id !== id),
        recentTrades: [data, ...state.recentTrades].slice(0, 20),
      }));
      toast.success('Position closed');
    } catch {
      toast.error('Failed to close position');
    }
  },

  closeAllPositions: async () => {
    set({ isKillSwitchActive: true });
    try {
      await api.post('/trades/close-all');
      set({
        openTrades: [],
        positions: [],
      });
      toast.success('All positions closed');
    } catch {
      toast.error('Failed to close all positions');
    } finally {
      set({ isKillSwitchActive: false });
    }
  },

  addTradeEvent: (event) =>
    set((state) => ({
      executionLog: [event, ...state.executionLog].slice(0, 50),
    })),

  updatePosition: (position) =>
    set((state) => {
      const idx = state.positions.findIndex((p) => p.symbol === position.symbol);
      if (idx >= 0) {
        const next = [...state.positions];
        next[idx] = position;
        return { positions: next };
      }
      return { positions: [...state.positions, position] };
    }),

  setOpenTrades: (trades) => set({ openTrades: trades }),
  setPositions: (positions) => set({ positions }),
  setRiskStatus: (status) => set({ riskStatus: status }),
  setKillSwitchActive: (active) => set({ isKillSwitchActive: active }),
}));
