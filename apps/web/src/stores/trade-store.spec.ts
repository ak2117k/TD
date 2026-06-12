import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the shared axios instance so no real network call happens.
// `vi.hoisted` keeps the spy available inside the hoisted vi.mock factory.
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/services/api', () => ({ default: { get } }));
// toast is invoked from other store actions on import; stub it out.
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import {
  useTradeStore,
  deriveCapitalDeployed,
  derivePositionsCount,
  tradesToPositions,
} from './trade-store';
import type { Trade } from '@/types';

function makeTrade(over: Record<string, unknown>): Trade {
  return {
    id: 'T1',
    symbol: 'RELIANCE',
    exchange: 'NSE',
    side: 'BUY',
    orderType: 'MARKET',
    quantity: 10,
    entryPrice: 100,
    ltp: 100,
    pnl: 0,
    pnlPercent: 0,
    status: 'OPEN',
    strategy: 'manual',
    positionType: 'INTRADAY',
    isPaper: true,
    createdAt: new Date(),
    ...over,
  } as Trade;
}

beforeEach(() => {
  get.mockReset();
  useTradeStore.setState({ openTrades: [] });
});

describe('fetchOpenTrades', () => {
  it('sends source=MANUAL when scoped to the manual-trade page', async () => {
    get.mockResolvedValueOnce({ data: [] });
    await useTradeStore.getState().fetchOpenTrades('MANUAL');
    expect(get).toHaveBeenCalledWith('/trades/open', {
      params: { source: 'MANUAL' },
    });
  });

  it('omits the source param when called with no argument (shared consumers)', async () => {
    get.mockResolvedValueOnce({ data: [] });
    await useTradeStore.getState().fetchOpenTrades();
    expect(get).toHaveBeenCalledWith('/trades/open', { params: undefined });
  });

  it('populates openTrades from the response', async () => {
    get.mockResolvedValueOnce({
      data: [{ id: 'A', instrument: { symbol: 'TCS', exchange: 'NSE' } }],
    });
    await useTradeStore.getState().fetchOpenTrades('MANUAL');
    const trades = useTradeStore.getState().openTrades;
    expect(trades).toHaveLength(1);
    expect(trades[0].symbol).toBe('TCS');
  });
});

describe('derived capital / positions', () => {
  const trades: Trade[] = [
    makeTrade({ id: '1', entryPrice: 100, quantity: 10 }), // 1000
    makeTrade({ id: '2', entryPrice: 250, quantity: 4 }), // 1000
    makeTrade({ id: '3', entryPrice: 50, quantity: 3 }), // 150
  ];

  it('deriveCapitalDeployed sums entryPrice * quantity', () => {
    expect(deriveCapitalDeployed(trades)).toBe(2150);
  });

  it('derivePositionsCount counts open trades', () => {
    expect(derivePositionsCount(trades)).toBe(3);
  });

  it('handles empty / missing fields without crashing', () => {
    expect(deriveCapitalDeployed([])).toBe(0);
    expect(
      deriveCapitalDeployed([makeTrade({ entryPrice: undefined as unknown as number })]),
    ).toBe(0);
  });
});

describe('tradesToPositions', () => {
  it('maps a trade to a Position with entryPrice-based fallback when no ltp', () => {
    const [p] = tradesToPositions([
      makeTrade({ symbol: 'INFY', entryPrice: 200, quantity: 5, ltp: undefined as unknown as number, pnl: undefined as unknown as number }),
    ]);
    expect(p.symbol).toBe('INFY');
    expect(p.averagePrice).toBe(200);
    expect(p.ltp).toBe(200); // falls back to entryPrice
    expect(p.pnl).toBe(0);
  });

  it('computes P&L from ltp for a BUY', () => {
    const [p] = tradesToPositions([
      makeTrade({ side: 'BUY', entryPrice: 100, quantity: 10, ltp: 110, pnl: undefined as unknown as number, pnlPercent: undefined as unknown as number }),
    ]);
    expect(p.pnl).toBe(100); // (110-100)*10
    expect(p.pnlPercent).toBeCloseTo(10);
  });
});
