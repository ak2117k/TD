import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { WatchRepository } from './watch.repository';

describe('WatchRepository', () => {
  let repo: WatchRepository;
  let prisma: { watchEntry: any; watchEvent: any };

  beforeEach(async () => {
    prisma = {
      watchEntry: { create: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn() },
      watchEvent: { create: jest.fn(), findMany: jest.fn() },
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [WatchRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();
    repo = moduleRef.get(WatchRepository);
  });

  it('findActiveBySetupId returns existing WATCHING entry', async () => {
    prisma.watchEntry.findFirst.mockResolvedValue({ id: 'w1', status: 'WATCHING' });
    const found = await repo.findActiveBySetupId('s1');
    expect(found?.id).toBe('w1');
    expect(prisma.watchEntry.findFirst).toHaveBeenCalledWith({
      where: { setupId: 's1', status: { in: ['WATCHING', 'TRADED'] } },
    });
  });

  it('countActive returns count for WATCHING+TRADED only', async () => {
    prisma.watchEntry.count.mockResolvedValue(7);
    const n = await repo.countActive();
    expect(n).toBe(7);
    expect(prisma.watchEntry.count).toHaveBeenCalledWith({
      where: { status: { in: ['WATCHING', 'TRADED'] } },
    });
  });

  it('createEntry persists with serialized breakdown JSON', async () => {
    prisma.watchEntry.create.mockResolvedValue({ id: 'w2' });
    await repo.createEntry({
      alertId: 'a1', setupId: 's2', symbol: 'TCS-EQ', token: '11536',
      exchange: 'NSE', side: 'BUY', initialPrice: 4000, initialScore: 72,
      initialBreakdown: { foo: 1 }, profitTarget: 4150,
      profitTargetSource: 'indicator-sr', stopLossScore: 60,
    });
    expect(prisma.watchEntry.create).toHaveBeenCalled();
    const args = prisma.watchEntry.create.mock.calls[0][0];
    expect(args.data.initialBreakdown).toEqual({ foo: 1 });
    expect(args.data.status).toBeUndefined();
  });

  it('createEvent passes Prisma.JsonNull when breakdown is null', async () => {
    prisma.watchEvent.create.mockResolvedValue({ id: 'e1' });
    await repo.createEvent({ watchEntryId: 'w1', eventType: 'PRICE_CHANGE', price: 100, breakdown: null });
    const args = prisma.watchEvent.create.mock.calls[0][0];
    expect(args.data.breakdown).toBeDefined();
  });
});
