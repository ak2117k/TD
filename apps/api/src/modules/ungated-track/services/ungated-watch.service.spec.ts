import { Test } from '@nestjs/testing';
import { UngatedWatchService, UngatedSymbolDupError } from './ungated-watch.service';
import { UngatedWatchRepository } from '../repositories/ungated-watch.repository';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import {
  UngatedPaperAccountService, TRADE_CAPITAL, MAX_CONCURRENT,
  UngatedCapitalExhaustedError, UngatedPositionCapError,
} from './ungated-paper-account.service';
import { UngatedTradeExecutionService } from './ungated-trade-execution.service';
import { UngatedWatchGateway } from '../gateways/ungated-watch.gateway';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

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
      wasTokenExecutedSince: jest.fn().mockResolvedValue(false),
      getLastClosedPnlForToken: jest.fn().mockResolvedValue(null),
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
    const gateway = { emitEntry: jest.fn() };
    // Default: live quote returns the same price as Chartink hit so existing
    // assertions still pass unchanged. Tests that want to assert divergent
    // entry pricing override this mock per-case.
    const adapter = { getLiveQuote: jest.fn().mockResolvedValue({ ltp: 2000 }) };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedWatchService,
        { provide: UngatedWatchRepository, useValue: repo },
        { provide: UngatedTradeRepository, useValue: trades },
        { provide: UngatedPaperAccountService, useValue: account },
        { provide: UngatedTradeExecutionService, useValue: exec },
        { provide: UngatedWatchGateway, useValue: gateway },
        { provide: AngelOneAdapterService, useValue: adapter },
      ],
    }).compile();
    svc = mod.get(UngatedWatchService);
    (svc as any).__adapter = adapter; // expose for per-test overrides
  });

  it('rejects when the same token already has a non-terminal entry (symbol-dup)', async () => {
    repo.findActiveByToken.mockResolvedValue([{ id: 'prev', token: '11536' }]);
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(UngatedSymbolDupError);
  });

  it('rejects SELL-direction alerts (BUY-only gate)', async () => {
    const { UngatedSellDirectionError } = await import('./ungated-watch.service');
    await expect(svc.createFromAlert({ ...baseInput, side: 'SELL' }))
      .rejects.toBeInstanceOf(UngatedSellDirectionError);
    expect(repo.findActiveByToken).not.toHaveBeenCalled();
    expect(repo.createEntry).not.toHaveBeenCalled();
  });

  it('rejects with UngatedStaleEntryError when live price leaves < 2% to original target', async () => {
    // ltp = 2020 → originalTarget = 2040 → remaining = 20 → 20/2020 = 0.99% < 2% → blocked
    const { UngatedStaleEntryError } = await import('./ungated-watch.service');
    (svc as any).__adapter.getLiveQuote.mockResolvedValue({ ltp: 2020 });
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(UngatedStaleEntryError);
    expect(repo.createEntry).not.toHaveBeenCalled();
  });

  it('rejects with UngatedStaleEntryError when the live price already reached the original target', async () => {
    // ltp = 2040 = exactly the 2% target → remaining = 0 → blocked
    const { UngatedStaleEntryError } = await import('./ungated-watch.service');
    (svc as any).__adapter.getLiveQuote.mockResolvedValue({ ltp: 2040 });
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(UngatedStaleEntryError);
    expect(repo.createEntry).not.toHaveBeenCalled();
  });

  it('anchors profitTarget to live fill price (not stale Chartink price)', async () => {
    // ltp = 1990 (stock dipped below alert price) → passes gate
    // profitTarget must be 1990 * 1.02 = 2029.8, not initialPrice * 1.02 = 2040
    (svc as any).__adapter.getLiveQuote.mockResolvedValue({ ltp: 1990 });
    await svc.createFromAlert(baseInput);
    const createCall = repo.createEntry.mock.calls[0][0];
    expect(createCall.profitTarget).toBeCloseTo(1990 * 1.02, 2);
  });

  it('rejects with UngatedCooldownError when the token was executed within the last 45 min', async () => {
    // Regression: ASHAPURMIN 2026-05-22 — 09:46:00 loss-cut, re-entered
    // 09:50:17 (4 min later) and loss-cut again. The cooldown constant
    // existed in code but the check wasn't wired into createFromAlert.
    const { UngatedCooldownError } = await import('./ungated-watch.service');
    repo.wasTokenExecutedSince.mockResolvedValue(true);
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(UngatedCooldownError);
  });

  it('rejects with UngatedLastLossError when last closed trade was a loss', async () => {
    const { UngatedLastLossError } = await import('./ungated-watch.service');
    repo.getLastClosedPnlForToken.mockResolvedValue(-120);
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(UngatedLastLossError);
    expect(repo.createEntry).not.toHaveBeenCalled();
  });

  it('allows entry when last closed trade was profitable', async () => {
    repo.getLastClosedPnlForToken.mockResolvedValue(80);
    await svc.createFromAlert(baseInput);
    expect(exec.openTrade).toHaveBeenCalled();
  });

  it('allows entry when no prior closed trade exists (first time)', async () => {
    repo.getLastClosedPnlForToken.mockResolvedValue(null);
    await svc.createFromAlert(baseInput);
    expect(exec.openTrade).toHaveBeenCalled();
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
    (svc as any).__adapter.getLiveQuote.mockResolvedValue({ ltp: 250_000 });
    await svc.createFromAlert({ ...baseInput, initialPrice: 250_000 });
    expect(exec.openTrade).toHaveBeenCalledWith(expect.objectContaining({ quantity: 1 }));
  });

  it('uses the LIVE broker quote (not Chartink hit price) for entryPrice + qty', async () => {
    // Regression: HONASA 2026-05-22 — ungated entered at the stale Chartink
    // hit price (₹389.35) while gated used a fresh live quote (₹393.12),
    // producing opposite-sign P&L on the SAME trade. Both tracks must now
    // anchor to the live broker quote at execute time for the A/B
    // comparison to be apples-to-apples.
    // ltp=1990 (slightly below initialPrice=2000): original target=2040, remaining=2.51% → gate passes.
    (svc as any).__adapter.getLiveQuote.mockResolvedValue({ ltp: 1990 }); // Chartink said 2000; live is 1990
    await svc.createFromAlert(baseInput);
    expect(exec.openTrade).toHaveBeenCalledWith(expect.objectContaining({
      entryPrice: 1990, // live quote, not 2000
      quantity: Math.floor(TRADE_CAPITAL / 1990),
    }));
  });

  it('falls back to Chartink hit price when the live quote is unavailable', async () => {
    (svc as any).__adapter.getLiveQuote.mockResolvedValue({ ltp: 0 });
    await svc.createFromAlert(baseInput);
    expect(exec.openTrade).toHaveBeenCalledWith(expect.objectContaining({
      entryPrice: 2000, // back to initialPrice
    }));
  });

  it('falls back to Chartink hit price when the live quote throws', async () => {
    (svc as any).__adapter.getLiveQuote.mockRejectedValue(new Error('broker timeout'));
    await svc.createFromAlert(baseInput);
    expect(exec.openTrade).toHaveBeenCalledWith(expect.objectContaining({
      entryPrice: 2000,
    }));
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
    const gateway = { emitEntry: jest.fn() };
    const adapter = { getLiveQuote: jest.fn().mockResolvedValue({ ltp: 2000 }) };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedWatchService,
        { provide: UngatedWatchRepository, useValue: repo },
        { provide: UngatedTradeRepository, useValue: { } },
        { provide: UngatedPaperAccountService, useValue: account },
        { provide: UngatedTradeExecutionService, useValue: exec },
        { provide: UngatedWatchGateway, useValue: gateway },
        { provide: AngelOneAdapterService, useValue: adapter },
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

  it('caps exit price at SL threshold when 30s poll already overshot below SL (BUY)', async () => {
    // Regression: 30s REST polling gap — stock fell from 2000 to 1975 within one window.
    // SL threshold is 2000 * 0.996 = 1992. Without the cap, exitPrice = 1975 → loss > 0.4%.
    // With the cap, exitPrice is pinned at 1992 regardless of how far ltp fell.
    repo.findActiveByToken.mockResolvedValue([tradedEntry()]);
    await svc.onTick('11536', 1975, new Date());
    expect(exec.closeTrade).toHaveBeenCalledWith('ut1', expect.objectContaining({
      reason: 'sl-loss-cut', exitPrice: 1992,
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
