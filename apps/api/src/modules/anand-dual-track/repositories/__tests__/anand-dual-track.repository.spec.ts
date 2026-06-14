import { Test } from '@nestjs/testing';
import { AnandDualTrackRepository } from '../anand-dual-track.repository';
import { PrismaService } from '../../../../common/prisma/prisma.service';

describe('AnandDualTrackRepository', () => {
  let repo: AnandDualTrackRepository;
  let prisma: {
    intradayEntry: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    swingEntry: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
    chartinkAlert: {
      findMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      intradayEntry: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      swingEntry: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      chartinkAlert: {
        findMany: jest.fn().mockResolvedValue([]),
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

  it('listWatchingIntraday returns only TRADED rows', async () => {
    const row = { id: 'i1', symbol: 'RELIANCE', token: '123', entryPrice: 2500, status: 'TRADED', targetPct: 5, stopPct: 5 };
    prisma.intradayEntry.findMany.mockResolvedValue([row]);
    const result = await repo.listWatchingIntraday();
    expect(prisma.intradayEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'TRADED' }) }),
    );
    expect(result).toHaveLength(1);
  });

  it('listWatchingSwing returns only TRADED rows', async () => {
    const row = { id: 's1', symbol: 'TCS', token: '456', entryPrice: 3500, status: 'TRADED', targetPct: 10, stopPct: 10 };
    prisma.swingEntry.findMany.mockResolvedValue([row]);
    const result = await repo.listWatchingSwing();
    expect(result).toHaveLength(1);
  });

  describe('listSwingExits', () => {
    it('queries exited swing rows (non-TRADED + non-null exitedAt), ordered by exitedAt desc', async () => {
      const row = { id: 's1', symbol: 'TCS', token: '456', entryPrice: 3500, exitPrice: 3850, exitedAt: new Date(), status: 'TARGET_HIT', targetPct: 10, stopPct: 10 };
      prisma.swingEntry.findMany.mockResolvedValue([row]);
      const result = await repo.listSwingExits({});
      expect(result).toHaveLength(1);
      expect(prisma.swingEntry.findMany).toHaveBeenCalledWith({
        where: { status: { not: 'TRADED' }, exitedAt: { not: null } },
        orderBy: { exitedAt: 'desc' },
        take: 200,
      });
    });

    it('applies from/to as an exitedAt window (gte/lte) alongside the not-null guard', async () => {
      prisma.swingEntry.findMany.mockResolvedValue([]);
      const from = new Date('2026-06-01T00:00:00Z');
      const to = new Date('2026-06-12T00:00:00Z');
      await repo.listSwingExits({ from, to });
      expect(prisma.swingEntry.findMany).toHaveBeenCalledWith({
        where: { status: { not: 'TRADED' }, exitedAt: { not: null, gte: from, lte: to } },
        orderBy: { exitedAt: 'desc' },
        take: 200,
      });
    });

    it('filters by a specific exit status when one is provided', async () => {
      prisma.swingEntry.findMany.mockResolvedValue([]);
      await repo.listSwingExits({ status: 'STOPPED' });
      expect(prisma.swingEntry.findMany).toHaveBeenCalledWith({
        where: { status: 'STOPPED', exitedAt: { not: null } },
        orderBy: { exitedAt: 'desc' },
        take: 200,
      });
    });

    it('falls back to the not-TRADED guard when status is empty', async () => {
      prisma.swingEntry.findMany.mockResolvedValue([]);
      await repo.listSwingExits({ status: '' });
      expect(prisma.swingEntry.findMany).toHaveBeenCalledWith({
        where: { status: { not: 'TRADED' }, exitedAt: { not: null } },
        orderBy: { exitedAt: 'desc' },
        take: 200,
      });
    });
  });

  describe('getSwingCapital', () => {
    it('derives invested/realized/available from SwingEntry rows', async () => {
      // open: floor(200000/2000)=100 lots @ 2000 → invested 200000
      // exited: floor(200000/100)=2000 lots, (105-100)*2000 = +10000 realized
      prisma.swingEntry.findMany
        .mockResolvedValueOnce([{ entryPrice: 2000, status: 'TRADED' }])
        .mockResolvedValueOnce([{ entryPrice: 100, exitPrice: 105, status: 'TARGET_HIT' }]);
      const result = await repo.getSwingCapital();
      expect(result.baseCapital).toBe(2_000_000);
      expect(result.investedOpen).toBe(200_000);
      expect(result.realizedPnl).toBe(10_000);
      expect(result.available).toBe(2_000_000 - 200_000 + 10_000);
      expect(result.openCount).toBe(1);
    });

    it('counts stop-outs as realized losses that still recycle capital', async () => {
      // floor(200000/100)=2000 lots, (90-100)*2000 = -20000 realized
      prisma.swingEntry.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ entryPrice: 100, exitPrice: 90, status: 'STOPPED' }]);
      const result = await repo.getSwingCapital();
      expect(result.investedOpen).toBe(0);
      expect(result.realizedPnl).toBe(-20_000);
      expect(result.available).toBe(2_000_000 - 20_000);
      expect(result.openCount).toBe(0);
    });
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

  describe('findActiveTradedBySymbol', () => {
    it('returns null when no TRADED entry exists for symbol', async () => {
      prisma.intradayEntry.findFirst.mockResolvedValue(null);
      const result = await repo.findActiveTradedBySymbol('intraday', 'RELIANCE');
      expect(result).toBeNull();
      expect(prisma.intradayEntry.findFirst).toHaveBeenCalledWith({
        where: { symbol: 'RELIANCE', status: 'TRADED' },
        select: { id: true },
      });
    });

    it('returns the entry when a TRADED entry exists for symbol (intraday)', async () => {
      prisma.intradayEntry.findFirst.mockResolvedValue({ id: 'i1' });
      const result = await repo.findActiveTradedBySymbol('intraday', 'TCS');
      expect(result).toEqual({ id: 'i1' });
    });

    it('queries swingEntry when track is swing', async () => {
      prisma.swingEntry.findFirst.mockResolvedValue({ id: 's1' });
      const result = await repo.findActiveTradedBySymbol('swing', 'INFY');
      expect(result).toEqual({ id: 's1' });
      expect(prisma.swingEntry.findFirst).toHaveBeenCalledWith({
        where: { symbol: 'INFY', status: 'TRADED' },
        select: { id: true },
      });
    });
  });

  describe('findScannerNamesByAlertIds', () => {
    it('returns empty map for empty input', async () => {
      const result = await repo.findScannerNamesByAlertIds([]);
      expect(result.size).toBe(0);
      expect(prisma.chartinkAlert.findMany).not.toHaveBeenCalled();
    });

    it('returns map of alertId → scanName', async () => {
      prisma.chartinkAlert.findMany.mockResolvedValue([
        { id: 'a1', scanner: { scanName: 'ANAND SWING' } },
        { id: 'a2', scanner: { scanName: 'BREAKOUT 5MIN' } },
      ]);
      const result = await repo.findScannerNamesByAlertIds(['a1', 'a2']);
      expect(result.get('a1')).toBe('ANAND SWING');
      expect(result.get('a2')).toBe('BREAKOUT 5MIN');
      expect(prisma.chartinkAlert.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['a1', 'a2'] } },
        select: { id: true, scanner: { select: { scanName: true } } },
      });
    });
  });

  describe('getPnlSummary — totalPnlRs', () => {
    it('includes totalPnlRs = 0 when no exits', async () => {
      prisma.intradayEntry.findMany.mockResolvedValue([]);
      const summary = await repo.getPnlSummary('intraday');
      expect(summary.daily.totalPnlRs).toBe(0);
      expect(summary.yearly.totalPnlRs).toBe(0);
    });

    it('computes totalPnlRs as sum of (exitPct/100)*200000 across exits', async () => {
      const now = new Date();
      prisma.intradayEntry.findMany.mockResolvedValue([
        { exitedAt: now, entryPrice: 100, exitPrice: 105 },
        { exitedAt: now, entryPrice: 100, exitPrice: 95 },
      ]);
      const summary = await repo.getPnlSummary('intraday');
      expect(summary.daily.totalPnlRs).toBeCloseTo(0, 2);
      expect(summary.daily.count).toBe(2);
    });

    it('totalPnlRs is positive when all exits are profitable', async () => {
      const now = new Date();
      prisma.intradayEntry.findMany.mockResolvedValue([
        { exitedAt: now, entryPrice: 1000, exitPrice: 1050 },
        { exitedAt: now, entryPrice: 2000, exitPrice: 2100 },
      ]);
      const summary = await repo.getPnlSummary('intraday');
      expect(summary.daily.totalPnlRs).toBeCloseTo(20000, 0);
    });

    it('blends intraday partial-booked legs (50% @ +3%, runner stopped -2% → +0.5%)', async () => {
      const now = new Date();
      prisma.intradayEntry.findMany.mockResolvedValue([
        { exitedAt: now, entryPrice: 100, exitPrice: 98, partialExitPrice: 103, partialFraction: 0.5 },
      ]);
      const summary = await repo.getPnlSummary('intraday');
      // blended +0.5% (a raw final-leg calc would have read -2%)
      expect(summary.daily.avgExitPct).toBeCloseTo(0.5, 6);
      expect(summary.daily.winCount).toBe(1);
      expect(summary.daily.totalPnlRs).toBeCloseTo((0.5 / 100) * 200000, 2);
    });
  });
});
