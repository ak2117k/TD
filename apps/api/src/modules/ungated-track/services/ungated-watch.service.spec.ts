import { Test } from '@nestjs/testing';
import { UngatedWatchService, UngatedSymbolDupError } from './ungated-watch.service';
import { UngatedWatchRepository } from '../repositories/ungated-watch.repository';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import {
  UngatedPaperAccountService, TRADE_CAPITAL, MAX_CONCURRENT,
  UngatedCapitalExhaustedError, UngatedPositionCapError,
} from './ungated-paper-account.service';
import { UngatedTradeExecutionService } from './ungated-trade-execution.service';

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
    const mod = await Test.createTestingModule({
      providers: [
        UngatedWatchService,
        { provide: UngatedWatchRepository, useValue: repo },
        { provide: UngatedTradeRepository, useValue: trades },
        { provide: UngatedPaperAccountService, useValue: account },
        { provide: UngatedTradeExecutionService, useValue: exec },
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
