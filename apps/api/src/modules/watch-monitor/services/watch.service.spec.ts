import { Test } from '@nestjs/testing';
import { WatchService, WatchCapExceededError } from './watch.service';
import { WatchRepository } from '../repositories/watch.repository';
import { TargetCalculatorService } from './target-calculator.service';
import { StrikeSelectorService } from './strike-selector.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { LevelBookService } from '../../signal-generator/services/level-book.service';
import { WatchGateway } from '../gateways/watch.gateway';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';

const mockTrade = { closeTrade: jest.fn().mockResolvedValue({}) };

describe('WatchService.createFromAlert', () => {
  let svc: WatchService;
  let repo: any;
  let target: any;
  let strike: any;
  let feed: any;
  let levelBook: any;

  beforeEach(async () => {
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
      ],
    }).compile();
    svc = mod.get(WatchService);
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
      profitTarget: 4150, profitTargetSource: 'indicator-sr', stopLossScore: 60,
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

  it('drops stale ticks older than lastTickAt', async () => {
    repo.findActiveByToken.mockResolvedValue([{
      id: 'w1', token: '11536', side: 'BUY', status: 'WATCHING',
      initialPrice: 4000, lastEventPrice: 4000, profitTarget: 4150,
      lastTickAt: new Date('2026-05-13T10:00:05Z'),
      maxFavorable: 4000, maxAdverse: 4000,
    }]);
    await svc.onTick('11536', 4010, new Date('2026-05-13T10:00:00Z'));
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
