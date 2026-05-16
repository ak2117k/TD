import { AngelOneAdapterService } from './angel-one-adapter.service';
import { AngelOneAuthService } from './angel-one-auth.service';
import { AngelOneWebSocketService } from './angel-one-websocket.service';

/**
 * Unit tests for AngelOneAdapterService.getMarketDepth — the only piece
 * of the adapter that's pure shape-mapping (no I/O, no scrip-master
 * lookups). The other methods are integration-bound.
 */
describe('AngelOneAdapterService.getMarketDepth', () => {
  function buildAdapter(marketDataMock: jest.Mock) {
    const fakeAuth = {
      getSmartApi: () => ({ marketData: marketDataMock }),
    } as unknown as AngelOneAuthService;
    const fakeWs = {
      on: jest.fn(),
      removeListener: jest.fn(),
    } as unknown as AngelOneWebSocketService;
    return new AngelOneAdapterService(fakeAuth, fakeWs);
  }

  it('maps Angel One depth.buy / depth.sell into the MarketDepth shape', async () => {
    const mock = jest.fn().mockResolvedValue({
      data: {
        fetched: [
          {
            depth: {
              buy: [
                { price: 100, quantity: 10, orders: 1 },
                { price: 99.5, quantity: 20, orders: 2 },
              ],
              sell: [
                { price: 100.5, quantity: 15, orders: 1 },
                { price: 101, quantity: 25, orders: 3 },
              ],
            },
          },
        ],
      },
    });
    const adapter = buildAdapter(mock);

    const depth = await adapter.getMarketDepth('3045', 'NSE');

    expect(depth).not.toBeNull();
    expect(depth!.bids).toHaveLength(2);
    expect(depth!.bids[0]).toEqual({ price: 100, qty: 10, orders: 1 });
    expect(depth!.asks[0]).toEqual({ price: 100.5, qty: 15, orders: 1 });
    expect(depth!.totalBidQty).toBe(30);
    expect(depth!.totalAskQty).toBe(40);
    expect(depth!.token).toBe('3045');
    expect(depth!.exchange).toBe('NSE');
    expect(typeof depth!.ts).toBe('number');
  });

  it('truncates beyond 5 levels per side', async () => {
    const tenLevels = Array.from({ length: 10 }, (_, i) => ({
      price: 100 - i * 0.05,
      quantity: 10,
      orders: 1,
    }));
    const mock = jest.fn().mockResolvedValue({
      data: {
        fetched: [{ depth: { buy: tenLevels, sell: tenLevels } }],
      },
    });
    const adapter = buildAdapter(mock);

    const depth = await adapter.getMarketDepth('3045', 'NSE');
    expect(depth!.bids).toHaveLength(5);
    expect(depth!.asks).toHaveLength(5);
  });

  it('serves the same response from cache within the 1.5s TTL', async () => {
    const mock = jest.fn().mockResolvedValue({
      data: {
        fetched: [
          {
            depth: {
              buy: [{ price: 100, quantity: 10, orders: 1 }],
              sell: [{ price: 100.5, quantity: 5, orders: 1 }],
            },
          },
        ],
      },
    });
    const adapter = buildAdapter(mock);

    const a = await adapter.getMarketDepth('3045', 'NSE');
    const b = await adapter.getMarketDepth('3045', 'NSE');
    expect(mock).toHaveBeenCalledTimes(1);
    // Same cached object reference confirms cache hit.
    expect(a).toBe(b);
  });

  it('returns null on SDK errors (graceful degradation)', async () => {
    const mock = jest.fn().mockRejectedValue(new Error('403 forbidden'));
    const adapter = buildAdapter(mock);

    const depth = await adapter.getMarketDepth('99926000', 'NSE');
    expect(depth).toBeNull();
  });

  it('returns an empty depth (cached briefly) when the broker reports no levels', async () => {
    const mock = jest.fn().mockResolvedValue({
      data: { fetched: [{ depth: { buy: [], sell: [] } }] },
    });
    const adapter = buildAdapter(mock);

    const depth = await adapter.getMarketDepth('99926000', 'NSE');
    expect(depth).not.toBeNull();
    expect(depth!.bids).toHaveLength(0);
    expect(depth!.asks).toHaveLength(0);
    expect(depth!.totalBidQty).toBe(0);
    expect(depth!.totalAskQty).toBe(0);
  });

  it('falls back to the camelCase bestBids/bestAsks shape when present', async () => {
    const mock = jest.fn().mockResolvedValue({
      data: {
        fetched: [
          {
            bestBids: [{ price: 250.1, quantity: 100, orders: 5 }],
            bestAsks: [{ price: 250.2, quantity: 80, orders: 4 }],
          },
        ],
      },
    });
    const adapter = buildAdapter(mock);

    const depth = await adapter.getMarketDepth('3045', 'NSE');
    expect(depth!.bids[0]).toEqual({ price: 250.1, qty: 100, orders: 5 });
    expect(depth!.asks[0]).toEqual({ price: 250.2, qty: 80, orders: 4 });
  });
});

/**
 * Task B — getHistoricalData in-memory TTL cache, and
 * Task C — detectable throttle (AngelThrottleError) for the data:null case.
 */
describe('AngelOneAdapterService — historical cache + throttle detection', () => {
  /** Build an adapter whose SmartAPI exposes a controllable getCandleData. */
  function buildAdapter(getCandleData: jest.Mock) {
    const fakeAuth = {
      getSmartApi: () => ({ getCandleData }),
    } as unknown as AngelOneAuthService;
    const fakeWs = {
      on: jest.fn(),
      removeListener: jest.fn(),
    } as unknown as AngelOneWebSocketService;
    return new AngelOneAdapterService(fakeAuth, fakeWs);
  }

  /** One candle row in Angel's array shape: [ts, o, h, l, c, v]. */
  function row(ts: string, c = 100): [string, number, number, number, number, number] {
    return [ts, c, c + 1, c - 1, c, 1000];
  }

  // ─── Task B: cache ────────────────────────────────────────────────────
  describe('candle cache', () => {
    it('serves a repeated fetch (same token:exchange:timeframe) from cache within TTL', async () => {
      const mock = jest
        .fn()
        .mockResolvedValue({ status: true, data: [row('2026-05-15 09:15'), row('2026-05-15 09:16')] });
      const adapter = buildAdapter(mock);
      const from = new Date('2026-05-15T03:45:00Z');
      const to = new Date('2026-05-15T04:00:00Z');

      const a = await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      const b = await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);

      expect(mock).toHaveBeenCalledTimes(1); // second call served from cache
      expect(b).toEqual(a);
      expect(b).toHaveLength(2);
    });

    it('refetches once the TTL has expired', async () => {
      const mock = jest
        .fn()
        .mockResolvedValue({ status: true, data: [row('2026-05-15 09:15')] });
      const adapter = buildAdapter(mock);
      const from = new Date('2026-05-15T03:45:00Z');
      const to = new Date('2026-05-15T04:00:00Z');

      jest.useFakeTimers();
      try {
        await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
        // Advance past the 1m TTL (~45s).
        jest.advanceTimersByTime(60_000);
        await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      } finally {
        jest.useRealTimers();
      }
      expect(mock).toHaveBeenCalledTimes(2);
    });

    it('does NOT cache an empty result (genuine data:[])', async () => {
      const mock = jest.fn().mockResolvedValue({ status: true, data: [] });
      const adapter = buildAdapter(mock);
      const from = new Date('2026-05-15T03:45:00Z');
      const to = new Date('2026-05-15T04:00:00Z');

      const a = await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      expect(a).toEqual([]);
      const b = await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      expect(b).toEqual([]);
      // Empty result must not be cached — the broker is re-hit.
      expect(mock).toHaveBeenCalledTimes(2);
    });

    it('does NOT cache a throttled (data:null) result', async () => {
      const mock = jest.fn().mockResolvedValue({ status: false, data: null, message: 'throttled' });
      const adapter = buildAdapter(mock);
      const from = new Date('2026-05-15T03:45:00Z');
      const to = new Date('2026-05-15T04:00:00Z');

      // A throttle is contained → returns [] (never thrown to the caller).
      const a = await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      expect(a).toEqual([]);
      // A second call must re-hit the broker (nothing cached).
      const b = await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      expect(b).toEqual([]);
      expect(mock).toHaveBeenCalledTimes(2);
    });

    it('keys the cache by token:exchange:timeframe — different tokens do not collide', async () => {
      const mock = jest
        .fn()
        .mockResolvedValue({ status: true, data: [row('2026-05-15 09:15')] });
      const adapter = buildAdapter(mock);
      const from = new Date('2026-05-15T03:45:00Z');
      const to = new Date('2026-05-15T04:00:00Z');

      await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      await adapter.getHistoricalData('99926000', 'NSE', '1m', from, to);
      await adapter.getHistoricalData('2885', 'NSE', '5m', from, to);
      // Three distinct keys → three broker calls.
      expect(mock).toHaveBeenCalledTimes(3);
      // Re-request the first key → still cached.
      await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      expect(mock).toHaveBeenCalledTimes(3);
    });
  });

  // ─── Task C: detectable throttle ──────────────────────────────────────
  describe('throttle detection (data:null)', () => {
    it('contains a throttle (data:null) — returns [] and logs a warning, never throws to callers', async () => {
      const mock = jest
        .fn()
        .mockResolvedValue({ status: false, data: null, message: 'Access denied because of exceeding access rate' });
      const adapter = buildAdapter(mock);
      const warn = jest
        .spyOn((adapter as any).logger, 'warn')
        .mockImplementation(() => {});
      const from = new Date('2026-05-15T03:45:00Z');
      const to = new Date('2026-05-15T04:00:00Z');

      // Detectable but contained: getHistoricalData keeps the [] contract for
      // all callers, and surfaces the throttle via a WARN log.
      const result = await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      expect(result).toEqual([]);
      expect(warn).toHaveBeenCalled();
    });

    it('returns [] (does NOT throw) for a genuine empty data:[] response', async () => {
      const mock = jest.fn().mockResolvedValue({ status: true, data: [] });
      const adapter = buildAdapter(mock);
      const from = new Date('2026-05-15T03:45:00Z');
      const to = new Date('2026-05-15T04:00:00Z');

      const result = await adapter.getHistoricalData('2885', 'NSE', '1m', from, to);
      expect(result).toEqual([]);
    });
  });
});
