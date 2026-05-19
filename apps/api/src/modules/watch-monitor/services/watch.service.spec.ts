import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { WatchService, WatchCapExceededError } from './watch.service';
import { WatchRepository } from '../repositories/watch.repository';
import { TargetCalculatorService } from './target-calculator.service';
import { StrikeSelectorService } from './strike-selector.service';
import { MarketFeedService, BROKER_ADAPTER_TOKEN } from '../../market-data/services/market-feed.service';
import { LevelBookService } from '../../signal-generator/services/level-book.service';
import { WatchGateway } from '../gateways/watch.gateway';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';
import { DEFAULT_MAX_CAPITAL_PER_TRADE } from '@td/shared';
import * as marketHours from '../../../common/utils/market-hours';

// Loosely typed: tests assign `executeTrade`/`closeTrade` dynamically per case.
const mockTrade: any = { closeTrade: jest.fn().mockResolvedValue({}) };

describe('WatchService.createFromAlert', () => {
  let svc: WatchService;
  let repo: any;
  let target: any;
  let strike: any;
  let feed: any;
  let levelBook: any;

  beforeEach(async () => {
    // Default: run as if INSIDE the 09:15-15:00 IST entry window so the
    // auto-execute path is exercised. The executeEntry cutoff describe-block
    // overrides this with its own spy to test the after-15:00 path.
    jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(true);
    repo = {
      findActiveBySetupId: jest.fn().mockResolvedValue(null),
      findActiveByToken: jest.fn().mockResolvedValue([]),
      countActive: jest.fn().mockResolvedValue(0),
      createEntry: jest.fn().mockResolvedValue({ id: 'w1', token: '11536' }),
      createEvent: jest.fn().mockResolvedValue({ id: 'e1' }),
    };
    target = { compute: jest.fn().mockReturnValue({ target: 4150, source: 'indicator-sr' }) };
    strike = { pick: jest.fn().mockResolvedValue(null) };
    feed = { subscribeForWatch: jest.fn() };
    // NOTE: LevelBookService uses getLevels(token) (sync), not getSnapshot.
    // The mock is named getLevels to match the real service API.
    levelBook = { getLevels: jest.fn().mockReturnValue(null) };

    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: target },
        { provide: StrikeSelectorService, useValue: strike },
        { provide: MarketFeedService, useValue: feed },
        { provide: LevelBookService, useValue: levelBook },
        { provide: WatchGateway, useValue: { emitTick: jest.fn(), emitEvent: jest.fn(), emitCreated: jest.fn() } },
        { provide: TradeExecutionService, useValue: mockTrade },
        { provide: BROKER_ADAPTER_TOKEN, useValue: { getLiveQuote: jest.fn().mockResolvedValue({ ltp: 4000 }) } },
      ],
    }).compile();
    svc = mod.get(WatchService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const baseInput = {
    alertId: 'a1', setupId: 's1', symbol: 'TCS-EQ', token: '11536',
    exchange: 'NSE', side: 'BUY' as const, initialPrice: 4000,
    initialScore: 72, initialBreakdown: { foo: 1 },
  };

  it('throws WatchCapExceededError at 50 active entries', async () => {
    repo.countActive.mockResolvedValue(50);
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(WatchCapExceededError);
    expect(repo.createEntry).not.toHaveBeenCalled();
  });

  it('emits a [trade-rejected] line when the watch cap is exceeded', async () => {
    repo.countActive.mockResolvedValue(50);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(
      WatchCapExceededError,
    );

    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.startsWith('[trade-rejected]'));
    expect(line).toBeDefined();
    expect(line).toContain('TCS-EQ');
    expect(line).toContain('stage=watch');
    expect(line).toContain('side=BUY');
    expect(line).toMatch(/reason="Watch entry cap exceeded/);
    warn.mockRestore();
  });

  it('emits a [trade-rejected] line when auto-execute fails', async () => {
    repo.findById = jest.fn().mockResolvedValue({
      id: 'w1', token: '11536', symbol: 'TCS-EQ', side: 'BUY',
      status: 'WATCHING', initialPrice: 4000, initialBreakdown: { lotCount: 1 },
      optionsToken: null, optionsLotSize: null,
    });
    repo.update = jest.fn().mockResolvedValue({});
    mockTrade.executeTrade = jest.fn().mockRejectedValue(
      new Error('Insufficient paper cash: need ₹20,00,000, available ₹0'),
    );
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await svc.createFromAlert(baseInput);

    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.startsWith('[trade-rejected]'));
    expect(line).toBeDefined();
    expect(line).toContain('TCS-EQ');
    expect(line).toContain('stage=execution');
    expect(line).toContain('side=BUY');
    expect(line).toMatch(/reason="Auto-execute failed/);
    warn.mockRestore();
  });

  it('returns existing entry on duplicate setupId (idempotent)', async () => {
    repo.findActiveBySetupId.mockResolvedValue({ id: 'existing', token: '11536' });
    const r = await svc.createFromAlert(baseInput);
    expect(r.id).toBe('existing');
    expect(repo.createEntry).not.toHaveBeenCalled();
  });

  it('returns existing entry when same stock is already being watched (token dedup)', async () => {
    // Different Chartink setup (different setupId) but SAME stock token.
    // Should return the existing entry instead of creating a duplicate.
    repo.findActiveBySetupId.mockResolvedValue(null); // new setup
    repo.findActiveByToken.mockResolvedValue([
      { id: 'first-watch-of-tcs', token: '11536', status: 'WATCHING', symbol: 'TCS-EQ' },
    ]);
    const r = await svc.createFromAlert(baseInput);
    expect(r.id).toBe('first-watch-of-tcs');
    expect(repo.createEntry).not.toHaveBeenCalled();
  });

  it('proceeds to create when no active entry exists for token (both dedups miss)', async () => {
    repo.findActiveBySetupId.mockResolvedValue(null);
    repo.findActiveByToken.mockResolvedValue([]); // no active watch for this token
    await svc.createFromAlert(baseInput);
    expect(repo.createEntry).toHaveBeenCalled();
  });

  it('creates entry, INITIAL event, subscribes feed on happy path', async () => {
    await svc.createFromAlert(baseInput);
    expect(repo.createEntry).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'TCS-EQ', side: 'BUY', initialPrice: 4000, initialScore: 72,
      profitTarget: 4150, profitTargetSource: 'indicator-sr', stopLossScore: 50,
    }));
    expect(repo.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      watchEntryId: 'w1', eventType: 'INITIAL', price: 4000, score: 72,
    }));
    expect(feed.subscribeForWatch).toHaveBeenCalledWith('11536', 'w1');
  });

  it('subscribes options token too when strike picker returns one', async () => {
    strike.pick.mockResolvedValue({
      optionsToken: 'OPT-TOKEN', optionsType: 'CE', optionsStrike: 4000,
      optionsExpiry: new Date('2026-05-27'), optionsLotSize: 175,
      optionsSelectionScore: 0.7,
    });
    await svc.createFromAlert(baseInput);
    expect(feed.subscribeForWatch).toHaveBeenCalledWith('11536', 'w1');
    expect(feed.subscribeForWatch).toHaveBeenCalledWith('OPT-TOKEN', 'w1');
  });

  it('subscribes to the feed only AFTER the entry is executed (no WATCHING tick race)', async () => {
    // Bug B: subscribing to the live feed before executeEntry flips the
    // entry to TRADED let a tick land while status was still WATCHING —
    // applyTick then skipped the price loss-cut (gated `status==='TRADED'`).
    // The feed subscription must happen after the execute step resolves.
    repo.findById = jest.fn().mockResolvedValue({
      id: 'w1', token: '11536', symbol: 'TCS-EQ', side: 'BUY',
      status: 'WATCHING', initialPrice: 4000, initialBreakdown: { lotCount: 1 },
      optionsToken: null, optionsLotSize: null, profitTarget: 4150,
    });
    repo.update = jest.fn().mockResolvedValue({});
    mockTrade.executeTrade = jest.fn().mockResolvedValue({ id: 'pt1', entryPrice: 4001 });

    await svc.createFromAlert(baseInput);

    expect(feed.subscribeForWatch).toHaveBeenCalled();
    expect(mockTrade.executeTrade).toHaveBeenCalled();
    const subscribeOrder = feed.subscribeForWatch.mock.invocationCallOrder[0];
    const executeOrder = mockTrade.executeTrade.mock.invocationCallOrder[0];
    expect(subscribeOrder).toBeGreaterThan(executeOrder);
  });

  it('auto-executes the paper trade after creating the entry', async () => {
    // Wire mocks to support the executeEntry path that runs at the tail of
    // createFromAlert. The user wants Chartink alert → score → auto-buy
    // without manual click.
    repo.findById = jest.fn().mockResolvedValue({
      id: 'w1',
      token: '11536',
      symbol: 'TCS-EQ',
      side: 'BUY',
      status: 'WATCHING',
      initialPrice: 4000,
      initialBreakdown: { lotCount: 1 },
      optionsToken: null,
      optionsLotSize: null,
      profitTarget: 4150,
    });
    repo.update = jest.fn().mockResolvedValue({});
    mockTrade.executeTrade = jest.fn().mockResolvedValue({
      id: 'paper-trade-123',
      entryPrice: 4001,
    });

    await svc.createFromAlert(baseInput);

    expect(mockTrade.executeTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'TCS-EQ',
        side: 'BUY',
        // floor(MAX_INVESTMENT_PER_TRADE / initialPrice) = floor(200,000 / 4000) = 50
        // (MAX_INVESTMENT_PER_TRADE is ₹2L per trade; the ₹20L is the total account balance.)
        quantity: 50,
        orderType: 'MARKET',
        positionType: 'INTRADAY',
        price: 4000,
      }),
    );
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'TRADED',
      executedPrice: 4001,
      paperTradeId: 'paper-trade-123',
    }));
  });

  it('sizes the auto-executed order within the per-trade risk cap', async () => {
    // Regression: the watch sizer built ~₹2,00,000 equity orders while the
    // RiskManager capped a single trade at maxCapitalPerTrade — so every
    // Chartink auto-execute was rejected and no paper trade ever filled.
    // The sized order value must never exceed the per-trade risk cap.
    repo.findById = jest.fn().mockResolvedValue({
      id: 'w1', token: '11536', symbol: 'BLUECHIP-EQ', side: 'BUY',
      status: 'WATCHING', initialPrice: 2000, initialBreakdown: { lotCount: 1 },
      optionsToken: null, optionsLotSize: null, profitTarget: 2100,
    });
    repo.update = jest.fn().mockResolvedValue({});
    mockTrade.executeTrade = jest.fn().mockResolvedValue({ id: 'pt1', entryPrice: 2000 });

    await svc.createFromAlert(baseInput);

    expect(mockTrade.executeTrade).toHaveBeenCalled();
    const order = mockTrade.executeTrade.mock.calls[0][0];
    const orderValue = order.quantity * order.price;
    expect(orderValue).toBeLessThanOrEqual(DEFAULT_MAX_CAPITAL_PER_TRADE);
  });

  it('passes the entry numeric token (not the symbol) to executeTrade', async () => {
    // Regression: executeEntry passed entry.symbol as the `token`, so
    // findInstrumentId (which matches {symbol} OR {token}) could not resolve
    // the NSE instrument — stored by numeric token — and every equity
    // auto-execute died with "Instrument not found".
    repo.findById = jest.fn().mockResolvedValue({
      id: 'w1', token: '11536', symbol: 'TCS-EQ', side: 'BUY',
      status: 'WATCHING', initialPrice: 4000, initialBreakdown: { lotCount: 1 },
      optionsToken: null, optionsLotSize: null, profitTarget: 4150,
    });
    repo.update = jest.fn().mockResolvedValue({});
    mockTrade.executeTrade = jest.fn().mockResolvedValue({ id: 'pt2', entryPrice: 4000 });

    await svc.createFromAlert(baseInput);

    expect(mockTrade.executeTrade).toHaveBeenCalledWith(
      expect.objectContaining({ token: '11536' }),
    );
  });

  it('leaves entry in WATCHING when auto-execute fails (e.g. insufficient cash)', async () => {
    // RiskManager raises an HttpException for cash shortfalls; the service
    // logs and swallows so the entry survives for manual retry.
    repo.findById = jest.fn().mockResolvedValue({
      id: 'w1', token: '11536', symbol: 'TCS-EQ', side: 'BUY',
      status: 'WATCHING', initialPrice: 4000, initialBreakdown: { lotCount: 1 },
      optionsToken: null, optionsLotSize: null,
    });
    repo.update = jest.fn().mockResolvedValue({});
    mockTrade.executeTrade = jest.fn().mockRejectedValue(
      new Error('Insufficient paper cash: need ₹20,00,000, available ₹0'),
    );

    const result = await svc.createFromAlert(baseInput);

    // The entry was created — that part doesn't roll back.
    expect(repo.createEntry).toHaveBeenCalled();
    // …but it was never marked TRADED.
    expect(repo.update).not.toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'TRADED',
    }));
    // Caller gets the original (WATCHING) entry back.
    expect(result.id).toBe('w1');
  });
});

describe('WatchService.onTick', () => {
  let svc: WatchService;
  let repo: any;
  let feed: any;
  let gateway: any;

  beforeEach(async () => {
    repo = {
      findActiveByToken: jest.fn(),
      // findById is used by unsubscribeEntry — provide a default resolved value
      findById: jest.fn().mockResolvedValue({ id: 'w1', token: '11536', optionsToken: null }),
      createEvent: jest.fn().mockResolvedValue({ id: 'e1' }),
      update: jest.fn().mockResolvedValue({}),
    };
    feed = { subscribeForWatch: jest.fn(), unsubscribeForWatch: jest.fn() };
    gateway = { emitTick: jest.fn(), emitEvent: jest.fn(), emitCreated: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: { compute: jest.fn() } },
        { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
        { provide: MarketFeedService, useValue: feed },
        { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
        { provide: WatchGateway, useValue: gateway },
        { provide: TradeExecutionService, useValue: mockTrade },
      ],
    }).compile();
    svc = mod.get(WatchService);
  });

  it('writes PRICE_CHANGE when |Δ| ≥ 0.25%', async () => {
    repo.findActiveByToken.mockResolvedValue([{
      id: 'w1', token: '11536', side: 'BUY', status: 'WATCHING',
      initialPrice: 4000, lastEventPrice: 4000, profitTarget: 4150,
      maxFavorable: 4000, maxAdverse: 4000,
    }]);
    await svc.onTick('11536', 4010, new Date('2026-05-13T10:00:00Z'));
    expect(repo.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'PRICE_CHANGE', price: 4010,
    }));
  });

  it('does NOT write PRICE_CHANGE when |Δ| < 0.25%', async () => {
    repo.findActiveByToken.mockResolvedValue([{
      id: 'w1', token: '11536', side: 'BUY', status: 'WATCHING',
      initialPrice: 4000, lastEventPrice: 4000, profitTarget: 4150,
      maxFavorable: 4000, maxAdverse: 4000,
    }]);
    await svc.onTick('11536', 4005, new Date('2026-05-13T10:00:00Z'));
    expect(repo.createEvent).not.toHaveBeenCalled();
  });

  it('transitions to TARGET_HIT when BUY price ≥ profitTarget', async () => {
    repo.findActiveByToken.mockResolvedValue([{
      id: 'w1', token: '11536', side: 'BUY', status: 'WATCHING',
      initialPrice: 4000, lastEventPrice: 4000, profitTarget: 4150,
      maxFavorable: 4000, maxAdverse: 4000, optionsToken: null,
    }]);
    await svc.onTick('11536', 4160, new Date('2026-05-13T10:00:00Z'));
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'TARGET_HIT',
    }));
    expect(repo.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'TARGET_HIT',
    }));
    expect(feed.unsubscribeForWatch).toHaveBeenCalledWith('11536', 'w1');
  });

  it('transitions to TARGET_HIT when SELL price ≤ profitTarget', async () => {
    repo.findActiveByToken.mockResolvedValue([{
      id: 'w1', token: '11536', side: 'SELL', status: 'WATCHING',
      initialPrice: 4000, lastEventPrice: 4000, profitTarget: 3850,
      maxFavorable: 4000, maxAdverse: 4000, optionsToken: null,
    }]);
    await svc.onTick('11536', 3840, new Date('2026-05-13T10:00:00Z'));
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'TARGET_HIT',
    }));
  });

  it('drops a genuinely out-of-order tick (older than lastTickAt, fresh broker clock)', async () => {
    // Realistic timestamps: both within the broker-clock trust window, so
    // the out-of-order guard applies and the reordered tick is dropped.
    const now = Date.now();
    const lastTick = new Date(now - 1_000);  // last processed 1s ago
    const staleTick = new Date(now - 6_000); // this tick is 6s older
    repo.findActiveByToken.mockResolvedValue([{
      id: 'w1', token: '11536', side: 'BUY', status: 'WATCHING',
      initialPrice: 4000, lastEventPrice: 4000, profitTarget: 4150,
      lastTickAt: lastTick,
      maxFavorable: 4000, maxAdverse: 4000,
    }]);
    await svc.onTick('11536', 4010, staleTick);
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.createEvent).not.toHaveBeenCalled();
  });
});

describe('WatchService.transitionStopped', () => {
  let svc: WatchService;
  let repo: any;
  let feed: any;

  beforeEach(async () => {
    repo = {
      findById: jest.fn().mockResolvedValue({
        id: 'w1', token: '11536', status: 'WATCHING', optionsToken: null,
      }),
      createEvent: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    };
    feed = { unsubscribeForWatch: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: { compute: jest.fn() } },
        { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
        { provide: MarketFeedService, useValue: feed },
        { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
        { provide: WatchGateway, useValue: { emitTick: jest.fn(), emitEvent: jest.fn(), emitCreated: jest.fn() } },
        { provide: TradeExecutionService, useValue: mockTrade },
      ],
    }).compile();
    svc = mod.get(WatchService);
  });

  it('writes SL_HIT_SCORE event and transitions to STOPPED', async () => {
    await svc.transitionStopped('w1', 55, 'score-decay');
    expect(repo.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'SL_HIT_SCORE', score: 55,
    }));
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'STOPPED', closedReason: 'sl-score-decay',
    }));
    expect(feed.unsubscribeForWatch).toHaveBeenCalled();
  });
});

describe('WatchService — exits close the linked paper trade', () => {
  let svc: WatchService;
  let repo: any;

  beforeEach(async () => {
    repo = {
      findById: jest.fn().mockResolvedValue({
        id: 'w1', token: '11536', symbol: 'TCS-EQ', status: 'TRADED',
        optionsToken: null, paperTradeId: 'pt-1',
      }),
      createEvent: jest.fn().mockResolvedValue({ id: 'e1' }),
      update: jest.fn().mockResolvedValue({}),
    };
    mockTrade.closeTrade = jest.fn().mockResolvedValue({});
    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: { compute: jest.fn() } },
        { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
        { provide: MarketFeedService, useValue: { unsubscribeForWatch: jest.fn() } },
        { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
        { provide: WatchGateway, useValue: { emitTick: jest.fn(), emitEvent: jest.fn(), emitCreated: jest.fn() } },
        { provide: TradeExecutionService, useValue: mockTrade },
      ],
    }).compile();
    svc = mod.get(WatchService);
  });

  it('transitionTargetHit closes the linked trade so cash is returned', async () => {
    await svc.transitionTargetHit('w1', 4160);
    expect(mockTrade.closeTrade).toHaveBeenCalledWith('pt-1', expect.anything());
  });

  it('transitionStopped closes the linked trade so cash is returned', async () => {
    await svc.transitionStopped('w1', 55, 'score-decay');
    expect(mockTrade.closeTrade).toHaveBeenCalledWith('pt-1', expect.anything());
  });
});

describe('WatchService.onTick — hard loss-cut', () => {
  // Reference price ₹2000 → qty = floor(200_000 / 2000) = 100 shares.
  // So a ₹1,000 loss = ₹10/share adverse move (₹2000 → ₹1990 for a BUY).
  let svc: WatchService;
  let repo: any;
  let feed: any;
  let gateway: any;

  beforeEach(async () => {
    repo = {
      findActiveByToken: jest.fn(),
      findById: jest.fn().mockResolvedValue({
        id: 'w1', token: '11536', symbol: 'TCS-EQ', status: 'TRADED',
        optionsToken: null, paperTradeId: 'pt-1',
      }),
      createEvent: jest.fn().mockResolvedValue({ id: 'e1' }),
      update: jest.fn().mockResolvedValue({}),
    };
    feed = { subscribeForWatch: jest.fn(), unsubscribeForWatch: jest.fn() };
    gateway = { emitTick: jest.fn(), emitEvent: jest.fn(), emitCreated: jest.fn() };
    mockTrade.closeTrade = jest.fn().mockResolvedValue({});
    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: { compute: jest.fn() } },
        { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
        { provide: MarketFeedService, useValue: feed },
        { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
        { provide: WatchGateway, useValue: gateway },
        { provide: TradeExecutionService, useValue: mockTrade },
      ],
    }).compile();
    svc = mod.get(WatchService);
  });

  function tradedEntry(overrides: Record<string, any> = {}) {
    return {
      id: 'w1', token: '11536', symbol: 'TCS-EQ', side: 'BUY', status: 'TRADED',
      initialPrice: 2000, executedPrice: 2000, profitTarget: 2200,
      optionsToken: null, optionsLotSize: null, paperTradeId: 'pt-1',
      partialExitedAt: null, trailingHighWater: null, trailingStopPrice: null,
      maxFavorable: 2000, maxAdverse: 2000, lastEventPrice: 2000, lastTickAt: null,
      ...overrides,
    };
  }

  it('cuts a TRADED entry whose open loss reaches ₹1,000', async () => {
    // ref=2000, qty=100. ltp=1990 → loss = -10 * 100 = -₹1,000 (exactly at threshold).
    repo.findActiveByToken.mockResolvedValue([tradedEntry()]);

    await svc.onTick('11536', 1990, new Date());

    expect(mockTrade.closeTrade).toHaveBeenCalledWith('pt-1', expect.anything());
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'STOPPED', closedReason: 'loss-cut',
    }));
    expect(repo.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'SL_HIT_PRICE',
    }));
  });

  it('does NOT cut when the open loss is just under ₹1,000', async () => {
    // ltp=1990.5 → loss = -9.5 * 100 = -₹950, below the ₹1,000 threshold.
    repo.findActiveByToken.mockResolvedValue([tradedEntry()]);

    await svc.onTick('11536', 1990.5, new Date());

    const lossCutUpdate = (repo.update.mock.calls as any[]).find(
      (call: any[]) => call[1]?.closedReason === 'loss-cut',
    );
    expect(lossCutUpdate).toBeUndefined();
    expect(mockTrade.closeTrade).not.toHaveBeenCalled();
  });

  it('never loss-cuts a WATCHING entry', async () => {
    // Same -₹1,000 adverse move but the entry was never traded.
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({ status: 'WATCHING', executedPrice: null, paperTradeId: null }),
    ]);

    await svc.onTick('11536', 1990, new Date());

    const lossCutUpdate = (repo.update.mock.calls as any[]).find(
      (call: any[]) => call[1]?.closedReason === 'loss-cut',
    );
    expect(lossCutUpdate).toBeUndefined();
    expect(mockTrade.closeTrade).not.toHaveBeenCalled();
  });

  it('loss-cuts even within the 10-minute grace window (fresh entry)', async () => {
    // executedAt = now → entry is brand new, well inside the score-decay
    // grace window. A price loss is a hard fact and must still cut.
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({ executedAt: new Date() }),
    ]);

    await svc.onTick('11536', 1985, new Date()); // loss = -15 * 100 = -₹1,500

    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'STOPPED', closedReason: 'loss-cut',
    }));
  });

  it('loss-cuts a SELL entry when price rises against it by ≥ ₹1,000', async () => {
    // SELL ref=2000, qty=100. ltp=2010 → loss = -(2010-2000)*100 = -₹1,000.
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({ side: 'SELL', profitTarget: 1800 }),
    ]);

    await svc.onTick('11536', 2010, new Date());

    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'STOPPED', closedReason: 'loss-cut',
    }));
  });

  it('still loss-cuts when consecutive ticks carry a stale (non-advancing) broker timestamp', async () => {
    // Repro of the BSHSL freeze: the broker keeps emitting ticks whose
    // timestamp is hours behind wall-clock. The first such tick set
    // lastTickAt to that stale value; every later tick is <= it, so the
    // out-of-order guard dropped them ALL — applyTick never ran again and
    // the loss-cut (which lives inside applyTick) was silently disabled.
    // A bad broker clock must NEVER be able to wedge tick processing.
    const staleTs = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3h ago
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({ lastTickAt: staleTs }),
    ]);

    // New tick also carries the stale timestamp; ltp=1985 → loss -₹1,500.
    await svc.onTick('11536', 1985, staleTs);

    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'STOPPED', closedReason: 'loss-cut',
    }));
  });
});

describe('WatchService.list — enrichment', () => {
  it('attaches scannerName and realizedPnl to each entry', async () => {
    const repo = {
      list: jest.fn().mockResolvedValue([
        { id: 'w1', alertId: 'a1', paperTradeId: 't1', liveTradeId: null, status: 'TARGET_HIT' },
        { id: 'w2', alertId: null, paperTradeId: null, liveTradeId: null, status: 'WATCHING' },
      ]),
      findScannerNames: jest.fn().mockResolvedValue(new Map([['a1', 'Scanner X']])),
      findRealizedPnls: jest.fn().mockResolvedValue(new Map([['t1', 4200]])),
    };
    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: { compute: jest.fn() } },
        { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
        { provide: MarketFeedService, useValue: {} },
        { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
        { provide: WatchGateway, useValue: {} },
        { provide: TradeExecutionService, useValue: mockTrade },
      ],
    }).compile();
    const svc = mod.get(WatchService);

    const result = await svc.list({ status: undefined, date: '2026-05-15' });

    expect(repo.list).toHaveBeenCalledWith({ status: undefined, date: '2026-05-15' });
    expect(result[0]).toMatchObject({ id: 'w1', scannerName: 'Scanner X', realizedPnl: 4200 });
    expect(result[1]).toMatchObject({ id: 'w2', scannerName: null, realizedPnl: null });
  });
});

describe('WatchService.executeEntry — 15:00 IST entry cutoff', () => {
  let svc: WatchService;
  let repo: any;
  let trade: any;
  let windowSpy: jest.SpyInstance;

  const watchingEntry = {
    id: 'w1', token: '11536', symbol: 'TCS-EQ', side: 'BUY',
    status: 'WATCHING', initialPrice: 4000, initialBreakdown: { lotCount: 1 },
    optionsToken: null, optionsLotSize: null, profitTarget: 4150,
  };

  async function build() {
    repo = {
      findById: jest.fn().mockResolvedValue(watchingEntry),
      update: jest.fn().mockResolvedValue({}),
    };
    trade = { executeTrade: jest.fn().mockResolvedValue({ id: 'pt1', entryPrice: 4001 }) };
    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: { compute: jest.fn().mockReturnValue({ target: 4080, source: 'fallback-2pct' }) } },
        { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
        { provide: MarketFeedService, useValue: { subscribeForWatch: jest.fn() } },
        { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
        { provide: WatchGateway, useValue: { emitTick: jest.fn() } },
        { provide: TradeExecutionService, useValue: trade },
        { provide: BROKER_ADAPTER_TOKEN, useValue: { getLiveQuote: jest.fn().mockResolvedValue({ ltp: 4000 }) } },
      ],
    }).compile();
    svc = mod.get(WatchService);
  }

  beforeEach(build);

  afterEach(() => {
    windowSpy?.mockRestore();
  });

  it('refuses to execute and leaves the entry WATCHING when outside the entry window', async () => {
    windowSpy = jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(false);

    const result = await svc.executeEntry('w1', { mode: 'paper' });

    // No broker call, entry never marked TRADED, no throw.
    expect(trade.executeTrade).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('logs a clear warning when refusing to execute outside the entry window', async () => {
    windowSpy = jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(false);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await svc.executeEntry('w1', { mode: 'paper' });

    const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('TCS-EQ');
    expect(line.toLowerCase()).toMatch(/entry window|15:00/);
    warn.mockRestore();
  });

  it('executes normally and marks the entry TRADED when inside the entry window', async () => {
    windowSpy = jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(true);

    const result = await svc.executeEntry('w1', { mode: 'paper' });

    expect(trade.executeTrade).toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'TRADED',
    }));
    expect(result).toMatchObject({ id: 'pt1' });
  });
});

describe('WatchService.executeEntry — live-quote pricing (Bug A)', () => {
  let svc: WatchService;
  let repo: any;
  let trade: any;
  let brokerAdapter: any;
  let target: any;

  const watchingEntry = {
    id: 'w1', token: '11536', symbol: 'TCS-EQ', side: 'BUY', exchange: 'NSE',
    status: 'WATCHING', initialPrice: 4000, initialBreakdown: { lotCount: 1 },
    optionsToken: null, optionsLotSize: null, profitTarget: 4150,
  };

  beforeEach(async () => {
    jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(true);
    repo = {
      findById: jest.fn().mockResolvedValue(watchingEntry),
      update: jest.fn().mockResolvedValue({}),
    };
    trade = { executeTrade: jest.fn().mockResolvedValue({ id: 'pt1', entryPrice: 3800 }) };
    brokerAdapter = { getLiveQuote: jest.fn().mockResolvedValue({ ltp: 3800 }) };
    target = { compute: jest.fn().mockReturnValue({ target: 3876, source: 'fallback-2pct' }) };
    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: target },
        { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
        { provide: MarketFeedService, useValue: { subscribeForWatch: jest.fn() } },
        { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
        { provide: WatchGateway, useValue: { emitTick: jest.fn() } },
        { provide: TradeExecutionService, useValue: trade },
        { provide: BROKER_ADAPTER_TOKEN, useValue: brokerAdapter },
      ],
    }).compile();
    svc = mod.get(WatchService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prices the order off the live quote, not the stale alert price', async () => {
    // Bug A: the Chartink trigger price (initialPrice) is 4000, but the live
    // market is 3800. The order must be priced off the live quote — opening
    // at a stale alert price births the position already mispriced.
    brokerAdapter.getLiveQuote.mockResolvedValue({ ltp: 3800 });

    await svc.executeEntry('w1', { mode: 'paper' });

    expect(trade.executeTrade).toHaveBeenCalledWith(
      expect.objectContaining({ price: 3800 }),
    );
  });

  it('refuses to execute when no live quote is available (no stale-price fill)', async () => {
    // With no live quote, executeEntry used to fall back to the stale
    // Chartink trigger price. It must instead refuse to trade and leave the
    // entry WATCHING — never open a position at an unverified price.
    brokerAdapter.getLiveQuote.mockRejectedValue(new Error('quote unavailable'));

    const result = await svc.executeEntry('w1', { mode: 'paper' });

    expect(trade.executeTrade).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalledWith(
      'w1', expect.objectContaining({ status: 'TRADED' }),
    );
    expect(result).toBeNull();
  });

  it('re-anchors the profit target to the actual execution price', async () => {
    // initialPrice (the Chartink alert price) is 4000; the live fill is 3800.
    // The profit target must be recomputed off 3800 — leaving it on the stale
    // 4000 anchor makes the band the wrong width vs the real entry, so a
    // target set off the alert price can sit a sliver above (or below) entry
    // and "hit" on noise within seconds for a near-zero / negative P&L.
    brokerAdapter.getLiveQuote.mockResolvedValue({ ltp: 3800 });
    target.compute.mockReturnValue({ target: 3876, source: 'fallback-2pct' });

    await svc.executeEntry('w1', { mode: 'paper' });

    expect(target.compute).toHaveBeenCalledWith(
      expect.objectContaining({ entryPrice: 3800 }),
    );
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      executedPrice: 3800,
      profitTarget: 3876,
      profitTargetSource: 'fallback-2pct',
    }));
  });
});
