import { Test } from '@nestjs/testing';
import { RiskGuardService } from './risk-guard.service';
import { WatchRepository } from '../repositories/watch.repository';
import { WatchService } from './watch.service';

describe('RiskGuardService', () => {
  let svc: RiskGuardService;
  let repo: { findTradedToday: jest.Mock };
  let watch: { squareOffAll: jest.Mock };

  beforeEach(async () => {
    repo = { findTradedToday: jest.fn() };
    watch = { squareOffAll: jest.fn().mockResolvedValue({ watchingClosed: 0, tradedClosed: 0, errors: 0 }) };
    const mod = await Test.createTestingModule({
      providers: [
        RiskGuardService,
        { provide: WatchRepository, useValue: repo },
        { provide: WatchService, useValue: watch },
      ],
    }).compile();
    svc = mod.get(RiskGuardService);
  });

  it('computes total daily P&L across TRADED entries (BUY side)', async () => {
    repo.findTradedToday.mockResolvedValue([
      { symbol: 'A', side: 'BUY', executedPrice: 100, currentPrice: 105 }, // +5 * 50 = +250
      { symbol: 'B', side: 'BUY', executedPrice: 200, currentPrice: 190 }, // -10 * 50 = -500
    ]);
    const r = await svc.computeDailyPnL();
    expect(r.pnl).toBe(-250);
    expect(r.breakdown).toHaveLength(2);
  });

  it('flips sign for SELL entries (profit when price drops)', async () => {
    repo.findTradedToday.mockResolvedValue([
      { symbol: 'A', side: 'SELL', executedPrice: 100, currentPrice: 95 }, // (95-100)*50*(-1) = +250
    ]);
    const r = await svc.computeDailyPnL();
    expect(r.pnl).toBe(250);
  });

  it('does NOT trip below loss limit', async () => {
    repo.findTradedToday.mockResolvedValue([
      { symbol: 'A', side: 'BUY', executedPrice: 1000, currentPrice: 999 }, // -50
    ]);
    expect(await svc.checkAndTrip()).toBe(false);
    expect(watch.squareOffAll).not.toHaveBeenCalled();
  });

  it('TRIPS when cumulative loss <= -₹60,000', async () => {
    // 50 shares × ₹1200 drop = -₹60,000
    repo.findTradedToday.mockResolvedValue([
      { symbol: 'A', side: 'BUY', executedPrice: 5000, currentPrice: 3800 },
    ]);
    expect(await svc.checkAndTrip()).toBe(true);
    expect(watch.squareOffAll).toHaveBeenCalledWith('daily-loss-breaker');
  });
});
