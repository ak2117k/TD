import { Test } from '@nestjs/testing';
import { BreakoutSwingPollerService } from './breakout-swing-poller.service';
import { BreakoutSwingRepository } from '../repositories/breakout-swing.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { NOTIONAL, INIT_STOP_PCT, TRAIL_GIVEBACK_PCT } from '../constants';

describe('BreakoutSwingPollerService.decideTradedTick (pure)', () => {
  const base = { entryPrice: 100, prevDayClose: 95, stopPrice: 90, trailing: false, trailingHighWater: null };

  it('TARGET_HIT at +10%', () => {
    expect(BreakoutSwingPollerService.decideTradedTick(base, 110, false)).toEqual({ action: 'TARGET_HIT' });
  });

  it('HOLD when between stop and target and not yet up 7%', () => {
    expect(BreakoutSwingPollerService.decideTradedTick(base, 103, false)).toEqual({ action: 'HOLD' });
  });

  it('STOPPED on the initial hard stop while not trailing', () => {
    expect(BreakoutSwingPollerService.decideTradedTick(base, 90, false)).toEqual({ action: 'STOPPED' });
  });

  it('arms the trailing stop once up +7% (RATCHET_TRAIL, stop = highWater × (1−giveback))', () => {
    const d = BreakoutSwingPollerService.decideTradedTick(base, 107.5, false);
    expect(d.action).toBe('RATCHET_TRAIL');
    if (d.action === 'RATCHET_TRAIL') {
      expect(d.highWater).toBe(107.5);
      expect(d.stopPrice).toBeCloseTo(107.5 * (1 - TRAIL_GIVEBACK_PCT / 100), 6);
    }
  });

  it('ratchets the trailing stop UP on a new high-water (still below the +10% target)', () => {
    const trailing = { ...base, trailing: true, trailingHighWater: 107.5, stopPrice: 107.5 * (1 - TRAIL_GIVEBACK_PCT / 100) };
    // 109 is +9% (below the +10% target) and a new high-water → ratchet up.
    const d = BreakoutSwingPollerService.decideTradedTick(trailing, 109, false);
    expect(d.action).toBe('RATCHET_TRAIL');
    if (d.action === 'RATCHET_TRAIL') {
      expect(d.highWater).toBe(109);
      expect(d.stopPrice).toBeCloseTo(109 * (1 - TRAIL_GIVEBACK_PCT / 100), 6);
    }
  });

  it('trailing stop fires (STOPPED) when price falls below the trailed stop — REPLACES the −10% stop', () => {
    const hw = 110;
    const trailStop = hw * (1 - TRAIL_GIVEBACK_PCT / 100); // 107.8
    const trailing = { ...base, trailing: true, trailingHighWater: hw, stopPrice: trailStop };
    // 108 is well above the −10% hard stop (90) but below the trailed stop → STOPPED.
    expect(BreakoutSwingPollerService.decideTradedTick(trailing, 107, false)).toEqual({ action: 'STOPPED' });
  });

  it('BIG_MOVER_EOD only inside the EOD window when the STOCK is up > 7% on the day', () => {
    // stock day move from prevClose 95 → 103 = +8.4% (> 7%), trade gain +3% (< target).
    const e = { ...base, prevDayClose: 95 };
    expect(BreakoutSwingPollerService.decideTradedTick(e, 103, true)).toEqual({ action: 'BIG_MOVER_EOD' });
    // Same price outside the window → no forced exit.
    expect(BreakoutSwingPollerService.decideTradedTick(e, 103, false)).toEqual({ action: 'HOLD' });
  });

  it('no BIG_MOVER_EOD when the stock day-move is ≤ 7% even in the window', () => {
    const e = { ...base, prevDayClose: 100 }; // 103 is +3% on the day
    expect(BreakoutSwingPollerService.decideTradedTick(e, 103, true)).toEqual({ action: 'HOLD' });
  });
});

describe('BreakoutSwingPollerService — poller integration', () => {
  let svc: BreakoutSwingPollerService;
  let repo: any;
  let adapter: any;

  beforeEach(async () => {
    repo = {
      listQueued: jest.fn().mockResolvedValue([]),
      listTraded: jest.fn().mockResolvedValue([]),
      fill: jest.fn().mockResolvedValue(undefined),
      setTrailing: jest.fn().mockResolvedValue(undefined),
      recordTick: jest.fn().mockResolvedValue(undefined),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };
    adapter = { getLtpsBatch: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        BreakoutSwingPollerService,
        { provide: BreakoutSwingRepository, useValue: repo },
        { provide: AngelOneAdapterService, useValue: adapter },
      ],
    }).compile();
    svc = mod.get(BreakoutSwingPollerService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fills a QUEUED entry when LTP reaches the resting limit → TRADED with qty + stop', async () => {
    repo.listQueued.mockResolvedValue([
      { id: 'q1', symbol: 'TCS', token: '11536', limitPrice: 101 },
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['11536', 101.5]]));

    await svc.pollMarketHours();

    const call = repo.fill.mock.calls[0];
    expect(call[0]).toBe('q1');
    expect(call[1].entryPrice).toBe(101.5);
    expect(call[1].quantity).toBe(Math.floor(NOTIONAL / 101.5));
    expect(call[1].stopPrice).toBeCloseTo(101.5 * (1 - INIT_STOP_PCT / 100), 6);
  });

  it('does NOT fill a QUEUED entry when LTP is below the resting limit', async () => {
    repo.listQueued.mockResolvedValue([
      { id: 'q1', symbol: 'TCS', token: '11536', limitPrice: 101 },
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['11536', 100.5]]));

    await svc.pollMarketHours();

    expect(repo.fill).not.toHaveBeenCalled();
  });

  it('arms the trailing stop on a TRADED entry once it is up +7%', async () => {
    // Freeze to 11:30 IST (mid-session, before the 15:15 big-mover window) so
    // pollMarketHours()'s real-clock isBigMoverWindow() doesn't force-exit the
    // +13.7%-on-the-day stock before the trailing stop can arm.
    jest.useFakeTimers({ now: new Date('2026-06-12T06:00:00Z') });
    repo.listTraded.mockResolvedValue([
      { id: 't1', symbol: 'TCS', token: '11536', entryPrice: 100, prevDayClose: 95, stopPrice: 90, trailing: false, trailingHighWater: null },
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['11536', 108]]));

    await svc.pollMarketHours();

    expect(repo.recordTick).toHaveBeenCalledWith('t1', expect.objectContaining({ currentPrice: 108 }));
    const setCall = repo.setTrailing.mock.calls[0];
    expect(setCall[0]).toBe('t1');
    expect(setCall[1].trailingHighWater).toBe(108);
    expect(setCall[1].stopPrice).toBeCloseTo(108 * (1 - TRAIL_GIVEBACK_PCT / 100), 6);
    expect(repo.updateStatus).not.toHaveBeenCalled();
  });

  it('big-mover EOD: force-exits a TRADED entry as BIG_MOVER_EOD inside the 15:15 window', async () => {
    // Freeze IST clock to 15:16 so isBigMoverWindow() is true.
    jest.useFakeTimers({ now: new Date('2026-06-12T09:46:00Z') }); // 15:16 IST
    repo.listTraded.mockResolvedValue([
      { id: 't1', symbol: 'TCS', token: '11536', entryPrice: 100, prevDayClose: 95, stopPrice: 90, trailing: false, trailingHighWater: null },
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['11536', 103]])); // +8.4% on the day, +3% trade

    await svc.pollMarketHours();

    expect(repo.updateStatus).toHaveBeenCalledWith('t1', expect.objectContaining({
      status: 'BIG_MOVER_EOD', exitPrice: 103,
    }));
    jest.useRealTimers();
  });
});
