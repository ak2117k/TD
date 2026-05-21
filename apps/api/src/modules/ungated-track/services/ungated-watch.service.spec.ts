import { Test } from '@nestjs/testing';
import { UngatedWatchService, UngatedSymbolDupError } from './ungated-watch.service';
import { UngatedWatchRepository } from '../repositories/ungated-watch.repository';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import {
  UngatedPaperAccountService, TRADE_CAPITAL, MAX_CONCURRENT,
  UngatedCapitalExhaustedError, UngatedPositionCapError,
} from './ungated-paper-account.service';
import { UngatedTradeExecutionService } from './ungated-trade-execution.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';

describe('UngatedWatchService.createFromAlert', () => {
  let svc: UngatedWatchService;
  let repo: any, trades: any, account: any, exec: any;

  const baseInput = {
    alertId: 'a1', setupId: null, symbol: 'TCS', token: '11536', exchange: 'NSE',
    side: 'BUY' as const, initialPrice: 2000, initialScore: 42,
    initialBreakdown: { checks: [] },
  };

  beforeEach(async () => {
    repo = {
      findActiveByToken: jest.fn().mockResolvedValue([]),
      countOpenTrades:   jest.fn().mockResolvedValue(0),
      createEntry:       jest.fn().mockResolvedValue({ id: 'uw1', token: '11536' }),
      createEvent:       jest.fn(),
      update:            jest.fn().mockResolvedValue({}),
      findById:          jest.fn().mockResolvedValue({
        id: 'uw1', token: '11536', side: 'BUY', initialPrice: 2000,
        status: 'WATCHING', exchange: 'NSE',
      }),
    };
    trades = {};
    account = {
      admit: jest.fn().mockResolvedValue(undefined),
      applyEntry: jest.fn(),
    };
    exec = {
      openTrade: jest.fn().mockResolvedValue({ id: 'ut1', entryPrice: 2000 }),
    };
    const feed = { subscribeForWatch: jest.fn(), unsubscribeForWatch: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedWatchService,
        { provide: UngatedWatchRepository, useValue: repo },
        { provide: UngatedTradeRepository, useValue: trades },
        { provide: UngatedPaperAccountService, useValue: account },
        { provide: UngatedTradeExecutionService, useValue: exec },
        { provide: MarketFeedService, useValue: feed },
      ],
    }).compile();
    svc = mod.get(UngatedWatchService);
  });

  it('rejects when the same token already has a non-terminal entry (symbol-dup)', async () => {
    repo.findActiveByToken.mockResolvedValue([{ id: 'prev', token: '11536' }]);
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(UngatedSymbolDupError);
  });

  it('forwards account.admit failures (capital / cap / kill-switch)', async () => {
    account.admit.mockRejectedValue(new UngatedCapitalExhaustedError(50_000));
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(UngatedCapitalExhaustedError);
  });

  it('on admission, sizes qty = floor(2L / initialPrice) and opens the trade', async () => {
    await svc.createFromAlert(baseInput);
    expect(exec.openTrade).toHaveBeenCalledWith(expect.objectContaining({
      quantity: Math.floor(TRADE_CAPITAL / 2000),
      entryPrice: 2000,
      side: 'BUY',
    }));
  });

  it('always sizes at least 1 share even when price exceeds TRADE_CAPITAL', async () => {
    await svc.createFromAlert({ ...baseInput, initialPrice: 250_000 });
    expect(exec.openTrade).toHaveBeenCalledWith(expect.objectContaining({ quantity: 1 }));
  });

  it('sets the entry to TRADED and persists paperTradeId after openTrade', async () => {
    await svc.createFromAlert(baseInput);
    expect(repo.update).toHaveBeenCalledWith('uw1', expect.objectContaining({
      status: 'TRADED', paperTradeId: 'ut1', executedPrice: 2000,
    }));
  });
});

describe('UngatedWatchService.onTick — transitions', () => {
  let svc: UngatedWatchService;
  let repo: any, account: any, exec: any;

  function tradedEntry(overrides: Record<string, any> = {}) {
    return {
      id: 'uw1', token: '11536', symbol: 'TCS', side: 'BUY', status: 'TRADED',
      initialPrice: 2000, executedPrice: 2000, profitTarget: 2040,
      paperTradeId: 'ut1', quantity: 100, remainingQty: 100,
      partialExitedAt: null, trailingHighWater: null, trailingStopPrice: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    repo = {
      findActiveByToken: jest.fn(),
      findById:          jest.fn(),
      createEvent:       jest.fn(),
      update:            jest.fn().mockResolvedValue({}),
    };
    account = {};
    exec = { closeTrade: jest.fn().mockResolvedValue({}) };
    const feed = { subscribeForWatch: jest.fn(), unsubscribeForWatch: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedWatchService,
        { provide: UngatedWatchRepository, useValue: repo },
        { provide: UngatedTradeRepository, useValue: { } },
        { provide: UngatedPaperAccountService, useValue: account },
        { provide: UngatedTradeExecutionService, useValue: exec },
        { provide: MarketFeedService, useValue: feed },
      ],
    }).compile();
    svc = mod.get(UngatedWatchService);
  });

  it('BUY: ltp >= profitTarget → target-hit, forwards exitPrice', async () => {
    repo.findActiveByToken.mockResolvedValue([tradedEntry()]);
    await svc.onTick('11536', 2045, new Date());
    expect(exec.closeTrade).toHaveBeenCalledWith('ut1', expect.objectContaining({
      reason: 'target-hit', exitPrice: 2045,
    }));
    expect(repo.update).toHaveBeenCalledWith('uw1', expect.objectContaining({
      status: 'TARGET_HIT',
    }));
  });

  it('hard loss-cut at -0.4% of deployed → forwards exitPrice', async () => {
    repo.findActiveByToken.mockResolvedValue([tradedEntry()]);
    await svc.onTick('11536', 1992, new Date());
    expect(exec.closeTrade).toHaveBeenCalledWith('ut1', expect.objectContaining({
      reason: 'sl-loss-cut', exitPrice: 1992,
    }));
    expect(repo.update).toHaveBeenCalledWith('uw1', expect.objectContaining({
      status: 'STOPPED', closedReason: 'loss-cut',
    }));
  });

  it('+1% favorable triggers partial exit, forwards exitPrice + sets trailing fields', async () => {
    repo.findActiveByToken.mockResolvedValue([tradedEntry({ profitTarget: 9999 })]);
    await svc.onTick('11536', 2020, new Date());
    expect(exec.closeTrade).toHaveBeenCalledWith('ut1', expect.objectContaining({
      reason: 'partial-exit', quantity: 50, exitPrice: 2020,
    }));
    expect(repo.update).toHaveBeenCalledWith('uw1', expect.objectContaining({
      partialExitedAt: expect.any(Date),
      partialExitPrice: 2020,
      partialQty: 50,
      remainingQty: 50,
      trailingHighWater: 2020,
      trailingStopPrice: 2020 * 0.995,
    }));
  });

  it('post-partial: price drops below trail → trailing-stop fires, exitPrice forwarded', async () => {
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({
        profitTarget: 9999, partialExitedAt: new Date(),
        partialExitPrice: 2020, partialQty: 50, remainingQty: 50,
        trailingHighWater: 2025, trailingStopPrice: 2025 * 0.995,
      }),
    ]);
    const trailStop = 2025 * 0.995;
    await svc.onTick('11536', trailStop - 1, new Date());
    expect(exec.closeTrade).toHaveBeenCalledWith('ut1', expect.objectContaining({
      reason: 'trailing-stop', exitPrice: trailStop - 1,
    }));
    expect(repo.update).toHaveBeenCalledWith('uw1', expect.objectContaining({
      status: 'EXITED', closedReason: 'trailing-stop',
    }));
  });
});
