import { create } from 'zustand';
import type { Trade, TradeEvent, RiskStatus } from '@/types';
import type { Position } from '@/types';
import api from '@/services/api';
import toast from 'react-hot-toast';

// M5: explicit shape for trade-execute payloads. The store previously
// accepted Record<string, unknown> so any extra keys *would* have flowed
// through, but a typed shape gives modal callers autocomplete and
// catches typos in field names like `entryReason` / `entryTags`.
export interface ExecuteTradeDto {
  symbol: string;
  token: string;
  exchange: string;
  side: string;
  orderType: string;
  quantity: number;
  price?: number;
  triggerPrice?: number;
  positionType: string;
  stoploss?: number;
  target?: number;
  entryReason?: string;
  entryTags?: string[];
  // Per-order paper/live flag (Manual Trade Terminal). Explicit flag wins on
  // the backend; absent flag falls back to the global paperTrading setting.
  isPaper?: boolean;
  // Allow forward-compat passthrough (e.g. signalId) without tightening
  // every caller in the same patch.
  [key: string]: unknown;
}

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
  executeTrade: (dto: ExecuteTradeDto) => Promise<void>;
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
      const { data } = await api.get<any[]>('/trades/open');
      // Normalize backend's isPaperTrade → frontend's isPaper field name,
      // and lift instrument.symbol/exchange to the top level (the JournalPage
      // and TradeCard read t.symbol / t.exchange directly).
      set({
        openTrades: (data ?? []).map((t) => ({
          ...t,
          isPaper: t.isPaper ?? t.isPaperTrade ?? false,
          symbol: t.symbol ?? t.instrument?.symbol ?? '',
          exchange: t.exchange ?? t.instrument?.exchange ?? '',
        })) as Trade[],
      });
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
      // M5 invariant: every closed trade must have a structured exit reason.
      // The proper UX is the ExitTradeModal (used from JournalPage), which
      // forces the trader to pick HIT_TARGET / STOPPED_OUT / etc. This
      // store action is a *fallback* invoked from the auto-trade page kill
      // path where there's no human present to pick a reason — we tag it
      // OTHER + exitNotes so the journal stays queryable rather than
      // collecting null exit reasons that would distort post-trade
      // analytics. Manual closes from the journal go through ExitTradeModal
      // and pass real reasons.
      const { data } = await api.post<Trade>(`/trades/${id}/close`, {
        exitReasonTag: 'OTHER',
        exitNotes: 'Closed via store action (auto-trade kill / non-modal path)',
      });
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
