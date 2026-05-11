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
  let paperService: { simulateOrder: jest.Mock; simulateTick: jest.Mock };
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
});
