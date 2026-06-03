import { Test } from '@nestjs/testing';
import { AnandDualTrackRepository } from '../anand-dual-track.repository';
import { PrismaService } from '../../../../common/prisma/prisma.service';

describe('AnandDualTrackRepository', () => {
  let repo: AnandDualTrackRepository;
  let prisma: {
    intradayEntry: {
      create: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    swingEntry: {
      create: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      intradayEntry: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      swingEntry: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      },
    };

    const mod = await Test.createTestingModule({
      providers: [
        AnandDualTrackRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repo = mod.get(AnandDualTrackRepository);
  });

  it('createIntradayEntry inserts with targetPct=5', async () => {
    prisma.intradayEntry.create.mockResolvedValue({ id: 'i1' });
    const result = await repo.createIntradayEntry({
      symbol: 'RELIANCE', token: '123', entryPrice: 2500, alertId: 'a1', scoreBreakdown: null,
    });
    expect(result.id).toBe('i1');
    expect(prisma.intradayEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ targetPct: 5, stopPct: 5 }) }),
    );
  });

  it('createSwingEntry inserts with targetPct=10', async () => {
    prisma.swingEntry.create.mockResolvedValue({ id: 's1' });
    const result = await repo.createSwingEntry({
      symbol: 'RELIANCE', token: '123', entryPrice: 2500, alertId: 'a1', scoreBreakdown: null,
    });
    expect(result.id).toBe('s1');
    expect(prisma.swingEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ targetPct: 10, stopPct: 10 }) }),
    );
  });

  it('listWatchingIntraday returns only WATCHING rows', async () => {
    const row = { id: 'i1', symbol: 'RELIANCE', token: '123', entryPrice: 2500, status: 'WATCHING', targetPct: 5, stopPct: 5 };
    prisma.intradayEntry.findMany.mockResolvedValue([row]);
    const result = await repo.listWatchingIntraday();
    expect(prisma.intradayEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'WATCHING' }) }),
    );
    expect(result).toHaveLength(1);
  });

  it('listWatchingSwing returns only WATCHING rows', async () => {
    const row = { id: 's1', symbol: 'TCS', token: '456', entryPrice: 3500, status: 'WATCHING', targetPct: 10, stopPct: 10 };
    prisma.swingEntry.findMany.mockResolvedValue([row]);
    const result = await repo.listWatchingSwing();
    expect(result).toHaveLength(1);
  });

  it('updateIntradayStatus sets status, exitPrice, exitedAt', async () => {
    prisma.intradayEntry.update.mockResolvedValue({});
    const now = new Date('2026-06-03T05:00:00Z');
    await repo.updateIntradayStatus('i1', { status: 'TARGET_HIT', exitPrice: 2625, exitedAt: now });
    expect(prisma.intradayEntry.update).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: { status: 'TARGET_HIT', exitPrice: 2625, exitedAt: now },
    });
  });

  it('expireAllWatchingIntraday updates all WATCHING rows to EXPIRED', async () => {
    prisma.intradayEntry.updateMany.mockResolvedValue({ count: 3 });
    const count = await repo.expireAllWatchingIntraday();
    expect(count).toBe(3);
    expect(prisma.intradayEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'WATCHING' }, data: expect.objectContaining({ status: 'EXPIRED' }) }),
    );
  });

  it('getPnlSummary returns daily/weekly/monthly/yearly stats', async () => {
    const exits = [
      { exitedAt: new Date(), entryPrice: 100, exitPrice: 105 },
      { exitedAt: new Date(), entryPrice: 100, exitPrice: 95 },
    ];
    prisma.intradayEntry.findMany.mockResolvedValue(exits);
    const result = await repo.getPnlSummary('intraday');
    expect(result.daily.count).toBe(2);
    expect(result.daily.winCount).toBe(1);
    expect(result.daily.avgExitPct).toBeCloseTo(0); // (+5 + -5) / 2
  });
});
