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
