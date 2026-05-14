import { Test, TestingModule } from '@nestjs/testing';
import { PaperTradeService } from './paper-trade.service';
import { TradeRepository } from '../repositories/trade.repository';
import { OrderRequest } from '../../../common/interfaces/broker-adapter.interface';

/** Stub repo for the service constructor — onModuleInit isn't called in these tests. */
const mockTradeRepository = {
  findPaperTradesSince: jest.fn().mockResolvedValue([]),
};

/**
 * Regression spec for the "paper trade entryPrice = 0/null" bug.
 *
 * Before the fix, simulateOrder() returned only { orderId, status, message }
 * — the slippage-adjusted fillPrice computed inside fillAtPrice() was
 * thrown away. TradeExecutionService then fell back to request.price ??
 * request.triggerPrice, both undefined for MARKET orders, so entryPrice
 * persisted as null and corrupted P&L (multiplier * (ltp - 0) * qty).
 *
 * The fix surfaces fillPrice on the OrderResponse so the caller can
 * record the actual fill on the trade row.
 */
describe('PaperTradeService.simulateOrder — fillPrice exposure', () => {
  let service: PaperTradeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: mockTradeRepository },
      ],
    }).compile();
    service = module.get(PaperTradeService);
  });

  it('MARKET order falls back to request.price when no LTP is cached, exposing it as fillPrice (+ slippage)', async () => {
    const request: OrderRequest = {
      symbol: 'NIFTY24MAY22500CE',
      token: '99926000',
      exchange: 'NFO',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 50,
      price: 125.5, // simulator uses this as base when LTP cache is empty
      positionType: 'INTRADAY',
    };

    const response = await service.simulateOrder(request);

    expect(response.status).toBe('FILLED');
    expect(response.fillPrice).toBeDefined();
    expect(response.fillPrice).toBeGreaterThan(0);
    // BUY slippage skews UP — fill should be at or above base price
    expect(response.fillPrice).toBeGreaterThanOrEqual(125.5);
    // …but not insanely far above (slippage cap is 0.05%)
    expect(response.fillPrice).toBeLessThanOrEqual(125.5 * 1.001);
  });

  it('MARKET SELL order applies negative slippage (fillPrice <= base)', async () => {
    const request: OrderRequest = {
      symbol: 'BANKNIFTY24MAY45000PE',
      token: '99926001',
      exchange: 'NFO',
      side: 'SELL',
      orderType: 'MARKET',
      quantity: 25,
      price: 200,
      positionType: 'INTRADAY',
    };

    const response = await service.simulateOrder(request);

    expect(response.status).toBe('FILLED');
    expect(response.fillPrice).toBeDefined();
    // SELL slippage skews DOWN
    expect(response.fillPrice).toBeLessThanOrEqual(200);
    expect(response.fillPrice).toBeGreaterThan(200 * 0.999);
  });

  it('LIMIT order with no LTP returns PENDING with no fillPrice', async () => {
    const request: OrderRequest = {
      symbol: 'NIFTY24MAY22500CE',
      token: '99926000',
      exchange: 'NFO',
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: 50,
      price: 100,
      positionType: 'INTRADAY',
    };

    const response = await service.simulateOrder(request);

    expect(response.status).toBe('PENDING');
    expect(response.fillPrice).toBeUndefined();
  });
});

/**
 * Position netting — partial-exit and trailing-stop SELL fills should reduce
 * the existing BUY position rather than spawning a new opposite-side slot.
 * Verifies the fix to Gap 1+3 from the watch-monitor partial-exit flow.
 */
describe('PaperTradeService.simulateOrder — position netting', () => {
  let service: PaperTradeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: mockTradeRepository },
      ],
    }).compile();
    service = module.get(PaperTradeService);
    service.resetVirtualPortfolio(2_000_000); // ₹20L fresh slate
  });

  const buildBuy = (qty: number, price: number): OrderRequest => ({
    symbol: 'TCS-EQ',
    token: '11536',
    exchange: 'NSE',
    side: 'BUY',
    orderType: 'MARKET',
    quantity: qty,
    price,
    positionType: 'INTRADAY',
  });

  const buildSell = (qty: number, price: number): OrderRequest => ({
    ...buildBuy(qty, price),
    side: 'SELL',
  });

  it('partial-exit SELL reduces the existing BUY qty instead of creating a new SELL slot', async () => {
    await service.simulateOrder(buildBuy(2000, 100));
    await service.simulateOrder(buildSell(1000, 101));

    const positions = service.getVirtualPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].side).toBe('BUY');
    expect(positions[0].quantity).toBe(1000);
    // averagePrice on the remaining long is the original cost basis (100),
    // not re-averaged by the partial close.
    expect(positions[0].averagePrice).toBeCloseTo(100, 1);
  });

  it('full-close SELL nets the position to zero (deleted from map)', async () => {
    await service.simulateOrder(buildBuy(2000, 100));
    await service.simulateOrder(buildSell(1000, 101));
    await service.simulateOrder(buildSell(1000, 100.5));

    expect(service.getVirtualPositions()).toHaveLength(0);
  });

  it('over-close flips the position to the opposite side at the new fill price', async () => {
    await service.simulateOrder(buildBuy(2000, 100));
    await service.simulateOrder(buildSell(3000, 102));

    const positions = service.getVirtualPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].side).toBe('SELL');
    expect(positions[0].quantity).toBe(1000);
    expect(positions[0].averagePrice).toBeCloseTo(102, 1);
  });

  it('account equity tracks correctly through the full partial-exit + trailing-stop flow', async () => {
    // BUY 2000 @ 100 → cash -200,000, deployed 200,000
    await service.simulateOrder(buildBuy(2000, 100));
    // Partial exit at +1%: SELL 1000 @ 101 → cash +101,000 (realized +1,000)
    await service.simulateOrder(buildSell(1000, 101));
    // Trailing stop fires: SELL 1000 @ 100.5 → cash +100,500 (realized +500)
    await service.simulateOrder(buildSell(1000, 100.5));

    const acc = service.getAccount();
    // Cash math (ignoring slippage): 2,000,000 - 200,000 + 101,000 + 100,500
    //   = 2,001,500. Slippage adds ±0.05% per fill — total worst case ~₹300.
    // The trade is profitable (closed +₹1,500 minus slippage costs), so we
    // bracket the result: noticeably above start, well under +₹2k.
    expect(acc.balance).toBeGreaterThan(2_000_500);
    expect(acc.balance).toBeLessThan(2_002_000);
    // Position fully closed → deployed=0, openPositions=0
    expect(acc.deployedCapital).toBe(0);
    expect(acc.openPositions).toBe(0);
    // Equity matches cash since no open positions remain.
    expect(acc.equity).toBe(acc.balance);
  });
});
