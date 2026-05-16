import { Test, TestingModule } from '@nestjs/testing';
import { PaperTradeService, BROKER_CHARGE_PER_EXIT } from './paper-trade.service';
import { TradeRepository } from '../repositories/trade.repository';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { OrderRequest } from '../../../common/interfaces/broker-adapter.interface';

/** Stub repo for the service constructor — onModuleInit isn't called in these tests. */
const mockTradeRepository = {
  findPaperTradesSince: jest.fn().mockResolvedValue([]),
};

/** Stub market feed — quote cache is empty unless a test overrides getQuote. */
const mockMarketFeed = {
  getQuote: jest.fn(() => null),
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
        { provide: MarketFeedService, useValue: mockMarketFeed },
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
        { provide: MarketFeedService, useValue: mockMarketFeed },
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

/**
 * Restart recovery — onModuleInit must rebuild BOTH the cash balance AND
 * the in-memory virtual positions from the persisted trades, so the
 * account view (deployedCapital / openPositions) survives a restart.
 */
describe('PaperTradeService.onModuleInit — balance + position rehydration', () => {
  async function buildWith(trades: any[]): Promise<PaperTradeService> {
    const repo = { findPaperTradesSince: jest.fn().mockResolvedValue(trades) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: repo },
        { provide: MarketFeedService, useValue: mockMarketFeed },
      ],
    }).compile();
    const service = module.get(PaperTradeService);
    await service.onModuleInit();
    return service;
  }

  it('rehydrates virtual positions from open trades so deployedCapital is restored', async () => {
    const service = await buildWith([
      {
        status: 'OPEN', side: 'BUY', quantity: 10, entryPrice: 1000, pnl: null,
        instrument: { symbol: 'TCS-EQ', exchange: 'NSE' },
      },
      {
        status: 'CLOSED', side: 'BUY', quantity: 5, entryPrice: 100, exitPrice: 200,
        pnl: 500, instrument: { symbol: 'INFY-EQ', exchange: 'NSE' },
      },
    ]);

    const acc = service.getAccount();
    expect(acc.openPositions).toBe(1);
    expect(acc.deployedCapital).toBe(10_000); // 10 * 1000
    // balance = 20L - 10,000 (open BUY cost) + 500 (closed pnl)
    expect(acc.balance).toBe(2_000_000 - 10_000 + 500);
  });

  it('rehydrates a PARTIALLY_FILLED trade as an open position of the remaining qty', async () => {
    const service = await buildWith([
      {
        status: 'PARTIALLY_FILLED', side: 'BUY', quantity: 6, entryPrice: 1000, pnl: 120,
        instrument: { symbol: 'TCS-EQ', exchange: 'NSE' },
      },
    ]);

    const acc = service.getAccount();
    expect(acc.openPositions).toBe(1);
    expect(acc.deployedCapital).toBe(6_000); // 6 remaining * 1000
    // balance = 20L - 6,000 (remaining cost) + 120 (realized partial pnl)
    expect(acc.balance).toBe(2_000_000 - 6_000 + 120);
  });

  it('a closed trade nets pnl MINUS its recorded broker fees', async () => {
    // fees accumulates ₹100 per exit; a trade that was partially then fully
    // closed carries ₹200. The replay must subtract it so the recovered
    // balance matches what applyExitAccounting did live.
    const service = await buildWith([
      {
        status: 'CLOSED', side: 'BUY', quantity: 10, entryPrice: 100,
        exitPrice: 150, pnl: 500, fees: 200,
        instrument: { symbol: 'INFY-EQ', exchange: 'NSE' },
      },
    ]);

    // balance = 20L + 500 (pnl) - 200 (fees)
    expect(service.getVirtualBalance()).toBe(2_000_000 + 500 - 200);
  });
});

/**
 * Broker-charge + deferred-profit accounting (applyExitAccounting).
 *
 * Every paper exit costs a flat ₹100 brokerage. A LOSING exit simply
 * loses the ₹100. A WINNING exit gets only its base capital back during
 * the session — the profit slice is withheld in `pendingProfit` and only
 * swept into cash after market hours by settlePendingProfit() at 18:00 IST.
 */
describe('PaperTradeService.applyExitAccounting — broker charge + deferred profit', () => {
  let service: PaperTradeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: mockTradeRepository },
        { provide: MarketFeedService, useValue: mockMarketFeed },
      ],
    }).compile();
    service = module.get(PaperTradeService);
    service.resetVirtualPortfolio(2_000_000);
  });

  it('a losing exit charges only the flat ₹100 brokerage and defers nothing', () => {
    const charge = service.applyExitAccounting(-5000);
    expect(charge).toBe(BROKER_CHARGE_PER_EXIT);
    expect(service.getVirtualBalance()).toBe(2_000_000 - 100);
    expect(service.getAccount().pendingProfit).toBe(0);
  });

  it('a winning exit withholds the profit — only base capital returns to cash', () => {
    const charge = service.applyExitAccounting(8000);
    expect(charge).toBe(BROKER_CHARGE_PER_EXIT);
    // cash drops by profit + brokerage; the profit is parked, not spendable
    expect(service.getVirtualBalance()).toBe(2_000_000 - 8000 - 100);
    expect(service.getAccount().pendingProfit).toBe(8000);
  });

  it('equity counts deferred profit, so a win lifts equity immediately (minus brokerage)', () => {
    service.applyExitAccounting(8000);
    const acc = service.getAccount();
    expect(acc.equity).toBe(2_000_000 - 100);
    expect(acc.pendingProfit).toBe(8000);
  });

  it('charges ₹100 per exit event — two partial exits cost ₹200', () => {
    service.applyExitAccounting(-100);
    service.applyExitAccounting(-100);
    expect(service.getVirtualBalance()).toBe(2_000_000 - 200);
  });
});

describe('PaperTradeService.settlePendingProfit — 18:00 IST after-hours settlement', () => {
  let service: PaperTradeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: mockTradeRepository },
        { provide: MarketFeedService, useValue: mockMarketFeed },
      ],
    }).compile();
    service = module.get(PaperTradeService);
    service.resetVirtualPortfolio(2_000_000);
  });

  it('sweeps accumulated deferred profit into the spendable cash balance', () => {
    service.applyExitAccounting(8000); // balance 1,991,900 · pending 8,000
    service.settlePendingProfit();
    expect(service.getVirtualBalance()).toBe(2_000_000 - 100); // profit credited back
    expect(service.getAccount().pendingProfit).toBe(0);
  });

  it('is a no-op when there is no pending profit', () => {
    service.applyExitAccounting(-3000); // pure loss — nothing deferred
    const balBefore = service.getVirtualBalance();
    service.settlePendingProfit();
    expect(service.getVirtualBalance()).toBe(balBefore);
  });

  it('equity is unchanged by settlement — it only moves pending → cash', () => {
    service.applyExitAccounting(8000);
    const equityBefore = service.getAccount().equity;
    service.settlePendingProfit();
    expect(service.getAccount().equity).toBe(equityBefore);
  });
});

/**
 * Live equity refresher — keeps open positions' unrealized P&L fresh by
 * polling the market-feed quote cache, independent of the tick stream.
 */
describe('PaperTradeService.refreshOpenPositions — live equity refresher', () => {
  async function buildWithFeed(feed: {
    getQuote: jest.Mock;
  }): Promise<PaperTradeService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: mockTradeRepository },
        { provide: MarketFeedService, useValue: feed },
      ],
    }).compile();
    const service = module.get(PaperTradeService);
    service.resetVirtualPortfolio(2_000_000);
    return service;
  }

  const buyOrder: OrderRequest = {
    symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
    orderType: 'MARKET', quantity: 2000, price: 100, positionType: 'INTRADAY',
  };

  it('updates each open position ltp/pnl from the market-feed quote cache', async () => {
    const feed = { getQuote: jest.fn(() => ({ ltp: 110 })) };
    const service = await buildWithFeed(feed);
    await service.simulateOrder(buyOrder);

    service.refreshOpenPositions();

    const pos = service.getVirtualPositions()[0];
    expect(feed.getQuote).toHaveBeenCalledWith('11536');
    expect(pos.ltp).toBe(110);
    // pnl = (110 - ~100) * 2000 ≈ 20,000 (entry slippage only)
    expect(pos.pnl).toBeGreaterThan(19_000);
    expect(service.getAccount().unrealizedPnl).toBeGreaterThan(19_000);
  });

  it('skips a position whose token has no cached quote, keeping its last value', async () => {
    const feed = { getQuote: jest.fn(() => null) };
    const service = await buildWithFeed(feed);
    await service.simulateOrder(buyOrder);

    expect(() => service.refreshOpenPositions()).not.toThrow();
    expect(service.getVirtualPositions()[0].pnl).toBe(0);
  });
});
