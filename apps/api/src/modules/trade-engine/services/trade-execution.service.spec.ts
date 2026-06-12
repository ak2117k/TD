import { Test, TestingModule } from '@nestjs/testing';
import { TradeExecutionService } from './trade-execution.service';
import { PaperTradeService } from './paper-trade.service';
import { RiskManagerService } from './risk-manager.service';
import { OrderTrackerService } from './order-tracker.service';
import { PositionManagerService } from './position-manager.service';
import { TradeRepository } from '../repositories/trade.repository';
import { TradeGateway } from '../gateways/trade.gateway';
import { SettingsService } from '../../settings/services/settings.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { MarketContextService } from '../../market-data/services/market-context.service';
import { BROKER_ADAPTER_TOKEN } from '../../market-data/services/market-feed.service';
import { ExitReasonTag } from '../dto/trade.dto';

/**
 * Builds an in-memory store of mock trades for the close-flow spec.
 * The real repository touches Prisma — we don't have DB in this test
 * session, so we substitute a tiny store that the service can update.
 */
function buildMockRepo() {
  const trades: Record<string, any> = {};
  return {
    _trades: trades,
    createTrade: jest.fn(async (data: any) => {
      const id = `trade_${Object.keys(trades).length + 1}`;
      const t = { id, ...data, status: data.status ?? 'OPEN', notes: data.notes ?? null };
      trades[id] = t;
      return t;
    }),
    updateTrade: jest.fn(async (id: string, data: any) => {
      trades[id] = { ...trades[id], ...data };
      return trades[id];
    }),
    getTradeById: jest.fn(async (id: string) => trades[id] ?? null),
    findInstrumentId: jest.fn(async () => 'inst_1'),
    getOpenTrades: jest.fn(async () =>
      Object.values(trades).filter((t: any) => t.status === 'OPEN'),
    ),
  };
}

describe('TradeExecutionService.closeTrade — exit-reason persistence', () => {
  let module: TestingModule;
  let service: TradeExecutionService;
  let repo: ReturnType<typeof buildMockRepo>;

  beforeEach(async () => {
    repo = buildMockRepo();
    // Seed an OPEN paper trade so closeTrade has something to act on
    repo._trades['trade_1'] = {
      id: 'trade_1',
      status: 'OPEN',
      side: 'BUY',
      quantity: 50,
      entryPrice: 100,
      isPaperTrade: true,
      positionType: 'INTRADAY',
      notes: null,
      instrument: { symbol: 'NIFTY', token: '99926000', exchange: 'NSE' },
    };

    module = await Test.createTestingModule({
      providers: [
        TradeExecutionService,
        { provide: BROKER_ADAPTER_TOKEN, useValue: null },
        {
          provide: PaperTradeService,
          useValue: {
            simulateOrder: jest.fn(async () => ({
              orderId: 'paper_order_1',
              status: 'FILLED',
              message: 'ok',
            })),
            simulateTick: jest.fn(),
            applyExitAccounting: jest.fn(),
          },
        },
        {
          provide: RiskManagerService,
          useValue: {
            validateTrade: jest.fn(async () => ({ allowed: true })),
            getDailyRiskStatus: jest.fn(async () => ({})),
            activateKillSwitch: jest.fn(),
          },
        },
        { provide: OrderTrackerService, useValue: { trackOrder: jest.fn() } },
        {
          provide: PositionManagerService,
          useValue: {
            addPosition: jest.fn(),
            removePosition: jest.fn(),
            reducePosition: jest.fn(),
            updatePositionPnL: jest.fn(),
          },
        },
        { provide: TradeRepository, useValue: repo },
        {
          provide: TradeGateway,
          useValue: {
            emitTradeUpdate: jest.fn(),
            emitKillSwitchActivated: jest.fn(),
            emitRiskStatus: jest.fn(),
          },
        },
        {
          provide: SettingsService,
          useValue: {
            getSettings: jest.fn(async () => ({ paperTrading: true })),
            activateKillSwitch: jest.fn(),
          },
        },
        {
          provide: MarketFeedService,
          useValue: { getQuote: jest.fn(() => null), getBreadth: jest.fn() },
        },
        {
          provide: MarketContextService,
          useValue: {
            snapshot: jest.fn(async () => ({
              underlying: 'NIFTY',
              spot: 22500,
              vix: 14.5,
              vixRegime: 'NORMAL',
              pcr: 1.1,
              maxPain: 22400,
              adRatio: 1.2,
              capturedAt: new Date(),
            })),
          },
        },
      ],
    }).compile();

    service = module.get(TradeExecutionService);
  });

  it('persists exitReasonTag and exitNotes on close (structured opts)', async () => {
    await service.closeTrade('trade_1', {
      exitReasonTag: ExitReasonTag.HIT_TARGET,
      exitNotes: 'Target reached at VWAP+1',
    });

    const persisted = repo._trades['trade_1'];
    expect(persisted.exitReasonTag).toBe('HIT_TARGET');
    expect(persisted.exitNotes).toBe('Target reached at VWAP+1');
    expect(persisted.status).toBe('CLOSED');
    expect(persisted.exitTime).toBeInstanceOf(Date);
  });

  it('back-compat: a string `reason` argument still flows into exitNotes', async () => {
    await service.closeTrade('trade_1', 'Kill switch: max daily loss');

    const persisted = repo._trades['trade_1'];
    expect(persisted.exitNotes).toBe('Kill switch: max daily loss');
    expect(persisted.exitReasonTag).toBeNull();
    expect(persisted.status).toBe('CLOSED');
  });
});

/**
 * Regression spec for the "paper trade entryPrice = 0/null" bug.
 *
 * The simulator now returns fillPrice; executeTrade must record it as
 * the trade's entryPrice so P&L and the position manager use the real
 * slippage-adjusted fill, not undefined/0.
 */
describe('TradeExecutionService.executeTrade — paper-trade entry price', () => {
  let module: TestingModule;
  let service: TradeExecutionService;
  let repo: ReturnType<typeof buildMockRepo>;
  let paperService: { simulateOrder: jest.Mock; simulateTick: jest.Mock; applyEntryCharge: jest.Mock };
  let positionManager: {
    addPosition: jest.Mock;
    removePosition: jest.Mock;
    updatePositionPnL: jest.Mock;
  };

  beforeEach(async () => {
    repo = buildMockRepo();
    paperService = {
      simulateOrder: jest.fn(async () => ({
        orderId: 'paper_order_42',
        status: 'FILLED',
        message: 'Paper trade filled at 127.43 (slippage: 0.0381)',
        fillPrice: 127.43,
      })),
      simulateTick: jest.fn(),
      applyEntryCharge: jest.fn(),
    };
    positionManager = {
      addPosition: jest.fn(),
      removePosition: jest.fn(),
      updatePositionPnL: jest.fn(),
    };

    module = await Test.createTestingModule({
      providers: [
        TradeExecutionService,
        { provide: BROKER_ADAPTER_TOKEN, useValue: null },
        { provide: PaperTradeService, useValue: paperService },
        {
          provide: RiskManagerService,
          useValue: {
            validateTrade: jest.fn(async () => ({ allowed: true })),
            getDailyRiskStatus: jest.fn(async () => ({})),
            activateKillSwitch: jest.fn(),
          },
        },
        { provide: OrderTrackerService, useValue: { trackOrder: jest.fn() } },
        { provide: PositionManagerService, useValue: positionManager },
        { provide: TradeRepository, useValue: repo },
        {
          provide: TradeGateway,
          useValue: {
            emitTradeUpdate: jest.fn(),
            emitKillSwitchActivated: jest.fn(),
            emitRiskStatus: jest.fn(),
          },
        },
        {
          provide: SettingsService,
          useValue: {
            getSettings: jest.fn(async () => ({ paperTrading: true })),
            activateKillSwitch: jest.fn(),
          },
        },
        {
          provide: MarketFeedService,
          useValue: { getQuote: jest.fn(() => null), getBreadth: jest.fn() },
        },
        {
          provide: MarketContextService,
          useValue: {
            snapshot: jest.fn(async () => ({
              underlying: 'NIFTY',
              spot: 22500,
              vix: 14.5,
              vixRegime: 'NORMAL',
              pcr: 1.1,
              maxPain: 22400,
              adRatio: 1.2,
              capturedAt: new Date(),
            })),
          },
        },
      ],
    }).compile();

    service = module.get(TradeExecutionService);
  });

  it('records the simulator fillPrice as entryPrice for filled MARKET paper orders', async () => {
    const trade = await service.executeTrade({
      symbol: 'NIFTY24MAY22500CE',
      token: '99926000',
      exchange: 'NFO',
      side: 'BUY' as any,
      orderType: 'MARKET' as any,
      quantity: 50,
      positionType: 'INTRADAY' as any,
      // NOTE: no price / triggerPrice — this is what trips the original bug
    } as any);

    expect(paperService.simulateOrder).toHaveBeenCalledTimes(1);
    expect(trade.entryPrice).toBe(127.43);
    expect(trade.status).toBe('OPEN');
    expect(trade.entryTime).toBeInstanceOf(Date);
  });

  it('propagates the fillPrice into the position-manager averagePrice', async () => {
    await service.executeTrade({
      symbol: 'NIFTY24MAY22500CE',
      token: '99926000',
      exchange: 'NFO',
      side: 'BUY' as any,
      orderType: 'MARKET' as any,
      quantity: 50,
      positionType: 'INTRADAY' as any,
    } as any);

    expect(positionManager.addPosition).toHaveBeenCalledTimes(1);
    const [, position] = positionManager.addPosition.mock.calls[0];
    expect(position.averagePrice).toBe(127.43);
  });

  it('falls back to request.price when the simulator omits fillPrice (defensive)', async () => {
    // Simulate an older/buggy implementation that doesn't return fillPrice.
    paperService.simulateOrder.mockResolvedValueOnce({
      orderId: 'paper_order_old',
      status: 'FILLED',
      message: 'legacy',
    });

    const trade = await service.executeTrade({
      symbol: 'NIFTY24MAY22500CE',
      token: '99926000',
      exchange: 'NFO',
      side: 'BUY' as any,
      orderType: 'LIMIT' as any,
      quantity: 50,
      price: 99.5,
      positionType: 'INTRADAY' as any,
    } as any);

    expect(trade.entryPrice).toBe(99.5);
  });

  it('charges the entry order and records it on the trade fees (R6)', async () => {
    const trade = await service.executeTrade({
      symbol: 'NIFTY24MAY22500CE', token: '99926000', exchange: 'NFO',
      side: 'BUY' as any, orderType: 'MARKET' as any, quantity: 50,
      positionType: 'INTRADAY' as any,
    } as any);

    expect(paperService.applyEntryCharge).toHaveBeenCalledTimes(1);
    expect(repo.updateTrade).toHaveBeenCalledWith(
      trade.id, expect.objectContaining({ fees: expect.any(Number) }),
    );
    // executeTrade makes exactly one updateTrade call (the entry-charge write).
    const fees = (repo.updateTrade as jest.Mock).mock.calls[0][1].fees;
    expect(fees).toBeGreaterThan(0);
  });

  // ----- ₹0 paper-fill rejection (Task 3) -----

  it('rejects a paper MARKET fill at ₹0 (no fillPrice, no request.price) and creates NO trade', async () => {
    // Simulator fills but returns no price — a MARKET order on a quiet feed.
    paperService.simulateOrder.mockResolvedValueOnce({
      orderId: 'paper_order_zero',
      status: 'FILLED',
      message: 'no ltp',
      // no fillPrice
    });

    await expect(
      service.executeTrade({
        symbol: 'ILLIQUIDCE',
        token: '12345',
        exchange: 'NFO',
        side: 'BUY' as any,
        orderType: 'MARKET' as any,
        quantity: 50,
        positionType: 'INTRADAY' as any,
        // no price / triggerPrice — nothing to fall back to
      } as any),
    ).rejects.toThrow(/No live price available for ILLIQUIDCE/);

    expect(repo.createTrade).not.toHaveBeenCalled();
  });

  it('rejects a paper MARKET fill at literal 0 and creates NO trade', async () => {
    paperService.simulateOrder.mockResolvedValueOnce({
      orderId: 'paper_order_zero2',
      status: 'FILLED',
      message: 'zero fill',
      fillPrice: 0,
    });

    await expect(
      service.executeTrade({
        symbol: 'NIFTY24MAY22500CE',
        token: '99926000',
        exchange: 'NFO',
        side: 'BUY' as any,
        orderType: 'MARKET' as any,
        quantity: 50,
        positionType: 'INTRADAY' as any,
      } as any),
    ).rejects.toThrow(/cannot place a .*MARKET paper order/);

    expect(repo.createTrade).not.toHaveBeenCalled();
  });

  it('a LIMIT order with request.price still fills at that price when fillPrice is 0/absent', async () => {
    // LTP is unavailable so the simulator returns no fillPrice, but a LIMIT
    // order carries an explicit price — it must fill at request.price, not throw.
    paperService.simulateOrder.mockResolvedValueOnce({
      orderId: 'paper_order_limit',
      status: 'FILLED',
      message: 'limit fill',
      // no fillPrice
    });

    const trade = await service.executeTrade({
      symbol: 'NIFTY24MAY22500CE',
      token: '99926000',
      exchange: 'NFO',
      side: 'BUY' as any,
      orderType: 'LIMIT' as any,
      quantity: 50,
      price: 101.25,
      positionType: 'INTRADAY' as any,
    } as any);

    expect(trade.entryPrice).toBe(101.25);
    expect(trade.status).toBe('OPEN');
  });

  // ----- source tagging (Task 2) -----

  it('defaults source to MANUAL when the caller omits it', async () => {
    const trade = await service.executeTrade({
      symbol: 'NIFTY24MAY22500CE',
      token: '99926000',
      exchange: 'NFO',
      side: 'BUY' as any,
      orderType: 'MARKET' as any,
      quantity: 50,
      positionType: 'INTRADAY' as any,
    } as any);

    expect((trade as any).source).toBe('MANUAL');
    const created = (repo.createTrade as jest.Mock).mock.calls[0][0];
    expect(created.source).toBe('MANUAL');
  });

  it('persists an explicit source (WATCH) through to createTrade', async () => {
    const trade = await service.executeTrade({
      symbol: 'NIFTY24MAY22500CE',
      token: '99926000',
      exchange: 'NFO',
      side: 'BUY' as any,
      orderType: 'MARKET' as any,
      quantity: 50,
      positionType: 'INTRADAY' as any,
      source: 'WATCH' as any,
    } as any);

    expect((trade as any).source).toBe('WATCH');
    const created = (repo.createTrade as jest.Mock).mock.calls[0][0];
    expect(created.source).toBe('WATCH');
  });
});

/**
 * Sibling regression spec for the paper-trade EXIT price bug.
 *
 * closeTrade() used to ignore paperResponse.fillPrice on the close side
 * and unconditionally fall back to getLastPrice() — so paper exits did
 * not reflect simulated exit slippage and every closed paper trade's
 * P&L was subtly wrong on the exit side. The journal (which we use to
 * evaluate which Chartink scanners produce winners) was being silently
 * corrupted. Mirror of the entry-side fix in e0c20c7.
 */
describe('TradeExecutionService.closeTrade — paper-trade exit price', () => {
  let module: TestingModule;
  let service: TradeExecutionService;
  let repo: ReturnType<typeof buildMockRepo>;
  let paperService: {
    simulateOrder: jest.Mock;
    simulateTick: jest.Mock;
    applyExitAccounting: jest.Mock;
  };
  let brokerAdapter: { getLiveQuote: jest.Mock; placeOrder: jest.Mock };

  beforeEach(async () => {
    repo = buildMockRepo();
    repo._trades['trade_1'] = {
      id: 'trade_1',
      status: 'OPEN',
      side: 'BUY',
      quantity: 50,
      entryPrice: 100,
      isPaperTrade: true,
      positionType: 'INTRADAY',
      notes: null,
      instrument: { symbol: 'NIFTY24MAY22500CE', token: '99926000', exchange: 'NFO' },
    };

    paperService = {
      simulateOrder: jest.fn(async () => ({
        orderId: 'paper_close_1',
        status: 'FILLED',
        message: 'Paper trade filled at 130.50 (slippage: 0.0381)',
        fillPrice: 130.5,
      })),
      simulateTick: jest.fn(),
      applyExitAccounting: jest.fn(),
    };

    brokerAdapter = {
      getLiveQuote: jest.fn(async () => ({ ltp: 125.0 })),
      placeOrder: jest.fn(async () => ({
        orderId: 'broker_close_1',
        status: 'FILLED',
        message: 'ok',
      })),
    };

    module = await Test.createTestingModule({
      providers: [
        TradeExecutionService,
        { provide: BROKER_ADAPTER_TOKEN, useValue: brokerAdapter },
        { provide: PaperTradeService, useValue: paperService },
        {
          provide: RiskManagerService,
          useValue: {
            validateTrade: jest.fn(async () => ({ allowed: true })),
            getDailyRiskStatus: jest.fn(async () => ({})),
            activateKillSwitch: jest.fn(),
          },
        },
        { provide: OrderTrackerService, useValue: { trackOrder: jest.fn() } },
        {
          provide: PositionManagerService,
          useValue: {
            addPosition: jest.fn(),
            removePosition: jest.fn(),
            reducePosition: jest.fn(),
            updatePositionPnL: jest.fn(),
          },
        },
        { provide: TradeRepository, useValue: repo },
        {
          provide: TradeGateway,
          useValue: {
            emitTradeUpdate: jest.fn(),
            emitKillSwitchActivated: jest.fn(),
            emitRiskStatus: jest.fn(),
          },
        },
        {
          provide: SettingsService,
          useValue: {
            getSettings: jest.fn(async () => ({ paperTrading: true })),
            activateKillSwitch: jest.fn(),
          },
        },
        {
          provide: MarketFeedService,
          useValue: { getQuote: jest.fn(() => null), getBreadth: jest.fn() },
        },
        {
          provide: MarketContextService,
          useValue: { snapshot: jest.fn(async () => null) },
        },
      ],
    }).compile();

    service = module.get(TradeExecutionService);
  });

  it('partial close reduces the position-manager position rather than removing it', async () => {
    await service.closeTrade('trade_1', { quantity: 20 });

    const pm = module.get(PositionManagerService) as unknown as {
      reducePosition: jest.Mock; removePosition: jest.Mock;
    };
    // slice P&L = (130.5 - 100) * 20 = 610
    expect(pm.reducePosition).toHaveBeenCalledWith('trade_1', 20, 610);
    expect(pm.removePosition).not.toHaveBeenCalled();
  });

  it('records the simulator fillPrice as exitPrice for paper closes', async () => {
    const trade = await service.closeTrade('trade_1', {
      exitReasonTag: ExitReasonTag.HIT_TARGET,
      exitNotes: 'Target reached',
    });

    expect(paperService.simulateOrder).toHaveBeenCalledTimes(1);
    expect(trade.exitPrice).toBe(130.5);
    // P&L = (130.5 - 100) * 50 = 1525
    expect(trade.pnl).toBeCloseTo(1525, 2);
    expect(trade.status).toBe('CLOSED');
  });

  // Regression: when the caller (watch-monitor stop/target/trail paths) knows
  // the actual trigger price, opts.exitPrice MUST override the simulator's
  // fill — the simulator's cached LTP can have drifted from the trigger by
  // the time the close order runs, silently corrupting realised P&L on the
  // Trade row. See POLICYBZR 2026-05-20: trigger 1834.60 → recorded 1842.22.
  it('uses opts.exitPrice over the simulator fillPrice when the caller passes a trigger price', async () => {
    // simulateOrder is set up to return fillPrice 130.5, but the caller knows
    // the stop fired at 92 — the recorded exitPrice MUST be 92.
    const trade = await service.closeTrade('trade_1', {
      reason: 'sl-loss-cut',
      exitPrice: 92,
    });

    expect(trade.exitPrice).toBe(92);
    // P&L = (92 - 100) * 50 = -400 — based on the trigger, not the stale fill.
    expect(trade.pnl).toBeCloseTo(-400, 2);
    expect(trade.status).toBe('CLOSED');
  });

  it('falls back to getLastPrice() when the simulator omits fillPrice', async () => {
    paperService.simulateOrder.mockResolvedValueOnce({
      orderId: 'paper_close_legacy',
      status: 'FILLED',
      message: 'legacy',
      // no fillPrice
    });

    const trade = await service.closeTrade('trade_1');

    // getLiveQuote returned ltp: 125.0 — that's the next fallback in the chain
    expect(trade.exitPrice).toBe(125.0);
  });

  it('logs an error when both fillPrice and lastPrice are missing AND entryPrice is 0', async () => {
    // Force every layer to fail: simulator omits fillPrice, broker throws,
    // and seed the trade with entryPrice=0 so the final fallback also fails.
    paperService.simulateOrder.mockResolvedValueOnce({
      orderId: 'paper_close_broken',
      status: 'FILLED',
      message: 'broken',
    });
    brokerAdapter.getLiveQuote.mockRejectedValueOnce(new Error('feed down'));
    repo._trades['trade_1'].entryPrice = 0;

    const errSpy = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => {});

    const trade = await service.closeTrade('trade_1');

    expect(trade.exitPrice).toBe(0);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toMatch(
      /Paper close .* resolved no exitPrice/,
    );
  });

  it('partial close: shrinks the original trade, marks PARTIALLY_FILLED, accumulates pnl', async () => {
    // closeTrade with an explicit quantity smaller than the trade closes
    // only that slice — the original Trade row must shrink, not spawn an
    // orphan row, so the trades table stays a clean source of truth.
    const trade = await service.closeTrade('trade_1', { quantity: 20 });

    expect(trade.status).toBe('PARTIALLY_FILLED');
    expect(trade.quantity).toBe(30); // 50 - 20
    // exit 20 @ 130.5, entry 100 → realized = (130.5 - 100) * 20 = 610
    expect(trade.pnl).toBeCloseTo(610, 2);
  });

  it('partial close records a correct, quantity-independent pnlPercent', async () => {
    // entry 100, exit 130.5 → price return +30.5%, independent of the 20/50
    // split. The old pnl/(entry x trade.quantity) formula inflated it.
    const trade = await service.closeTrade('trade_1', { quantity: 20 });

    expect(trade.status).toBe('PARTIALLY_FILLED');
    expect(trade.pnlPercent).toBeCloseTo(30.5, 1);
  });

  it('falls back to a real price when the simulator fills at 0 (no cached LTP)', async () => {
    // A market close for an instrument with no cached LTP fills at 0; the
    // old `??` chain accepted that 0 and booked a phantom catastrophic loss.
    paperService.simulateOrder.mockResolvedValueOnce({
      orderId: 'paper_close_zero',
      status: 'FILLED',
      message: 'no ltp',
      fillPrice: 0,
    });
    brokerAdapter.getLiveQuote.mockRejectedValueOnce(new Error('feed down'));

    const trade = await service.closeTrade('trade_1');

    // exit must fall back to entryPrice (100), never 0
    expect(trade.exitPrice).toBe(100);
    expect(trade.pnl).toBeCloseTo(0, 2);
    // and the close order must carry a real price so the cash credit is real
    const closeOrderArg = paperService.simulateOrder.mock.calls[0][0];
    expect(closeOrderArg.price).toBeGreaterThan(0);
  });
});

/**
 * Broker-charge feature - every paper exit routes through
 * PaperTradeService.applyExitAccounting with the slice P&L and the real
 * SEBI/exchange charge computed by computeOrderCharges. The charge is
 * persisted on the trade row's `fees` field so the startup balance replay
 * can reconstruct it.
 */
describe('TradeExecutionService.closeTrade — broker charge', () => {
  let module: TestingModule;
  let service: TradeExecutionService;
  let repo: ReturnType<typeof buildMockRepo>;
  let paperService: {
    simulateOrder: jest.Mock;
    simulateTick: jest.Mock;
    applyExitAccounting: jest.Mock;
  };

  beforeEach(async () => {
    repo = buildMockRepo();
    repo._trades['trade_1'] = {
      id: 'trade_1',
      status: 'OPEN',
      side: 'BUY',
      quantity: 50,
      entryPrice: 100,
      isPaperTrade: true,
      positionType: 'INTRADAY',
      notes: null,
      fees: 0,
      instrument: { symbol: 'NIFTY24MAY22500CE', token: '99926000', exchange: 'NFO' },
    };

    paperService = {
      simulateOrder: jest.fn(async () => ({
        orderId: 'paper_close_1',
        status: 'FILLED',
        message: 'ok',
        fillPrice: 130.5,
      })),
      simulateTick: jest.fn(),
      applyExitAccounting: jest.fn(() => 100),
    };

    const brokerAdapter = {
      getLiveQuote: jest.fn(async () => ({ ltp: 125.0 })),
      placeOrder: jest.fn(async () => ({
        orderId: 'broker_close_1',
        status: 'FILLED',
        message: 'ok',
      })),
    };

    module = await Test.createTestingModule({
      providers: [
        TradeExecutionService,
        { provide: BROKER_ADAPTER_TOKEN, useValue: brokerAdapter },
        { provide: PaperTradeService, useValue: paperService },
        {
          provide: RiskManagerService,
          useValue: {
            validateTrade: jest.fn(async () => ({ allowed: true })),
            getDailyRiskStatus: jest.fn(async () => ({})),
            activateKillSwitch: jest.fn(),
          },
        },
        { provide: OrderTrackerService, useValue: { trackOrder: jest.fn() } },
        {
          provide: PositionManagerService,
          useValue: {
            addPosition: jest.fn(),
            removePosition: jest.fn(),
            reducePosition: jest.fn(),
            updatePositionPnL: jest.fn(),
          },
        },
        { provide: TradeRepository, useValue: repo },
        {
          provide: TradeGateway,
          useValue: {
            emitTradeUpdate: jest.fn(),
            emitKillSwitchActivated: jest.fn(),
            emitRiskStatus: jest.fn(),
          },
        },
        {
          provide: SettingsService,
          useValue: {
            getSettings: jest.fn(async () => ({ paperTrading: true })),
            activateKillSwitch: jest.fn(),
          },
        },
        {
          provide: MarketFeedService,
          useValue: { getQuote: jest.fn(() => null), getBreadth: jest.fn() },
        },
        {
          provide: MarketContextService,
          useValue: { snapshot: jest.fn(async () => null) },
        },
      ],
    }).compile();

    service = module.get(TradeExecutionService);
  });

  it('routes a paper exit through applyExitAccounting with the slice P&L and a charge', async () => {
    await service.closeTrade('trade_1', { exitReasonTag: ExitReasonTag.HIT_TARGET });

    // slice P&L = (130.5 - 100) * 50 = 1525
    expect(paperService.applyExitAccounting).toHaveBeenCalledTimes(1);
    expect(paperService.applyExitAccounting).toHaveBeenCalledWith(1525, expect.any(Number));
  });

  it('records the real exit charge on the trade fees field (full close)', async () => {
    const trade = await service.closeTrade('trade_1');
    // Real SEBI charges on a ~6,525 turnover are a few rupees, not a flat 100.
    expect(trade.fees).toBeGreaterThan(0);
    expect(trade.fees).toBeLessThan(100);
  });

  it('charges a partial close too - slice P&L and fees both reflect the slice', async () => {
    const trade = await service.closeTrade('trade_1', { quantity: 20 });

    // slice P&L = (130.5 - 100) * 20 = 610
    expect(paperService.applyExitAccounting).toHaveBeenCalledWith(610, expect.any(Number));
    expect(trade.status).toBe('PARTIALLY_FILLED');
    expect(trade.fees).toBeGreaterThan(0);
  });

  it('accumulates fees across exits - a second close adds another charge', async () => {
    repo._trades['trade_1'].fees = 50; // an earlier leg already charged 50
    const trade = await service.closeTrade('trade_1');
    expect(trade.fees).toBeGreaterThan(50);
  });

  it('does NOT charge brokerage when closing a live (non-paper) trade', async () => {
    repo._trades['trade_1'].isPaperTrade = false;
    await service.closeTrade('trade_1');
    expect(paperService.applyExitAccounting).not.toHaveBeenCalled();
  });
});
