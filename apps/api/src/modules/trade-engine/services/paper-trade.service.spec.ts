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
