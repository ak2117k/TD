import { Test } from '@nestjs/testing';
import { AnandPriceMonitorService } from '../anand-price-monitor.service';
import { AnandDualTrackRepository } from '../../repositories/anand-dual-track.repository';
import { AngelOneAdapterService } from '../../../market-data/services/angel-one-adapter.service';

const makeEntry = (overrides: Partial<{
  id: string; symbol: string; token: string; entryPrice: number;
  targetPct: number; stopPct: number; status: string;
}> = {}) => ({
  id: 'i1', symbol: 'RELIANCE', token: '2885', entryPrice: 2500,
  targetPct: 5, stopPct: 5, status: 'WATCHING', exitPrice: null, exitedAt: null,
  ...overrides,
});

describe('AnandPriceMonitorService', () => {
  let service: AnandPriceMonitorService;
  let repo: {
    listWatchingIntraday: jest.Mock;
    listWatchingSwing: jest.Mock;
    updateIntradayStatus: jest.Mock;
    updateSwingStatus: jest.Mock;
    expireAllWatchingIntraday: jest.Mock;
  };
  let adapter: { getLtpsBatch: jest.Mock };

  beforeEach(async () => {
    repo = {
      listWatchingIntraday: jest.fn().mockResolvedValue([]),
      listWatchingSwing: jest.fn().mockResolvedValue([]),
      updateIntradayStatus: jest.fn().mockResolvedValue(undefined),
      updateSwingStatus: jest.fn().mockResolvedValue(undefined),
      expireAllWatchingIntraday: jest.fn().mockResolvedValue(0),
    };
    adapter = { getLtpsBatch: jest.fn().mockResolvedValue(new Map()) };

    const mod = await Test.createTestingModule({
      providers: [
        AnandPriceMonitorService,
        { provide: AnandDualTrackRepository, useValue: repo },
        { provide: AngelOneAdapterService, useValue: adapter },
      ],
    }).compile();

    service = mod.get(AnandPriceMonitorService);
  });

  it('marks intraday entry TARGET_HIT when ltp >= entryPrice * 1.05', async () => {
    repo.listWatchingIntraday.mockResolvedValue([makeEntry({ entryPrice: 2500, targetPct: 5 })]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2625]])); // +5%
    await service.pollMarketHours();
    expect(repo.updateIntradayStatus).toHaveBeenCalledWith('i1', expect.objectContaining({ status: 'TARGET_HIT', exitPrice: 2625 }));
  });

  it('marks intraday entry STOPPED when ltp <= entryPrice * 0.95', async () => {
    repo.listWatchingIntraday.mockResolvedValue([makeEntry({ entryPrice: 2500, stopPct: 5 })]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2374]])); // -5.04%
    await service.pollMarketHours();
    expect(repo.updateIntradayStatus).toHaveBeenCalledWith('i1', expect.objectContaining({ status: 'STOPPED' }));
  });

  it('does not update status when price is within range', async () => {
    repo.listWatchingIntraday.mockResolvedValue([makeEntry({ entryPrice: 2500 })]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2530]])); // +1.2%
    await service.pollMarketHours();
    expect(repo.updateIntradayStatus).not.toHaveBeenCalled();
  });

  it('marks swing entry TARGET_HIT when ltp >= entryPrice * 1.10', async () => {
    repo.listWatchingSwing.mockResolvedValue([makeEntry({ id: 's1', token: '2885', entryPrice: 3000, targetPct: 10, stopPct: 10 })]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 3300]])); // +10%
    await service.pollMarketHours();
    expect(repo.updateSwingStatus).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'TARGET_HIT', exitPrice: 3300 }));
  });

  it('expireIntradayAtClose calls expireAllWatchingIntraday', async () => {
    repo.expireAllWatchingIntraday.mockResolvedValue(4);
    await service.expireIntradayAtClose();
    expect(repo.expireAllWatchingIntraday).toHaveBeenCalled();
  });

  it('pollOvernight only processes swing entries', async () => {
    // Freeze clock to 20:30 IST (15:00 UTC) — outside market hours so the
    // guard does not return early.
    jest.useFakeTimers({ now: new Date('2026-06-03T14:30:00Z') });
    repo.listWatchingSwing.mockResolvedValue([makeEntry({ id: 's1', token: '2885', entryPrice: 3000, targetPct: 10, stopPct: 10 })]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 3300]]));
    await service.pollOvernight();
    jest.useRealTimers();
    expect(repo.listWatchingIntraday).not.toHaveBeenCalled();
    expect(repo.updateSwingStatus).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'TARGET_HIT' }));
  });

  it('skips token not found in ltp map', async () => {
    repo.listWatchingIntraday.mockResolvedValue([makeEntry({ token: 'unknown' })]);
    adapter.getLtpsBatch.mockResolvedValue(new Map()); // empty
    await service.pollMarketHours();
    expect(repo.updateIntradayStatus).not.toHaveBeenCalled();
  });
});
