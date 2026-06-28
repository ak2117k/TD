/**
 * TDA-003 Task 2 — Prisma tenant-scoping interceptor (security-critical).
 *
 * Drives a real `PrismaService` (with the `$use` scoping middleware) against the
 * throw-away `td_saas_test` database, simulating two tenants A and B. A second
 * raw `PrismaClient` (no middleware) is used to seed and to make ground-truth
 * assertions, so the proofs are independent of the interceptor under test.
 *
 * Tenant context is driven manually: `asTenant(ctx, fn)` opens a `cls.run`
 * scope and (optionally) sets `{ userId, role }` before invoking the scoped
 * client — exactly what the HTTP interceptor does per request.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:<pw>@127.0.0.1:5432/td_saas_test \
 *     npx jest --config test/tda003/jest.config.js -v
 */

import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import {
  TenantContext,
  TenantContextService,
} from '../../src/common/tenant/tenant-context.service';

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) {
  throw new Error(
    'DATABASE_URL_TEST must be set to the td_saas_test connection string ' +
      '(e.g. postgresql://postgres:<pw>@127.0.0.1:5432/td_saas_test)',
  );
}

// PrismaService resolves its connection from DATABASE_URL (via super()). Point
// it at the test DB so a stray run can NEVER touch the real td_saas database.
process.env.DATABASE_URL = testUrl;

// Ground-truth client: bypasses the scoping middleware entirely.
const raw = new PrismaClient({ datasources: { db: { url: testUrl } } });

// Wire the scoped client exactly as Nest would: ClsService -> TenantContext ->
// PrismaService. The SAME ClsService instance backs both the middleware reads
// and the asTenant() writes, so AsyncLocalStorage propagates the context.
const als = new AsyncLocalStorage<Record<string, unknown>>();
const cls = new ClsService(als);
const tenant = new TenantContextService(cls);
const prisma = new PrismaService(tenant);

/** Run `fn` inside a CLS scope carrying `ctx` (null = active scope, no tenant). */
function asTenant<T>(ctx: TenantContext | null, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    if (ctx) tenant.set(ctx);
    return fn();
  });
}

const SUFFIX = 'tda003-iso';
const EMAIL_A = `${SUFFIX}-a@test.local`;
const EMAIL_B = `${SUFFIX}-b@test.local`;
const INST_TOKEN = 'T003ISO';
const SIGNAL_STRATEGY = 'TDA003_ISO_TEST';

let instId: string;
let userAId: string;
let userBId: string;
let tradeAId: string;
let tradeBId: string;
let signalId: string;

async function cleanup(): Promise<void> {
  // Deleting the users cascades their trades (Trade.onDelete: Cascade).
  await raw.user.deleteMany({ where: { email: { in: [EMAIL_A, EMAIL_B] } } });
  await raw.signal.deleteMany({ where: { strategy: SIGNAL_STRATEGY } });
  await raw.instrument.deleteMany({ where: { token: INST_TOKEN } });
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await cleanup();

  const inst = await raw.instrument.create({
    data: {
      symbol: 'TDA003ISO',
      token: INST_TOKEN,
      name: 'Isolation Test Instrument',
      exchange: 'NSE',
      segment: 'EQ',
    },
  });
  instId = inst.id;

  const [userA, userB] = await Promise.all([
    raw.user.create({ data: { email: EMAIL_A, passwordHash: 'x', role: 'USER' } }),
    raw.user.create({ data: { email: EMAIL_B, passwordHash: 'x', role: 'USER' } }),
  ]);
  userAId = userA.id;
  userBId = userB.id;

  const baseTrade = {
    instrumentId: instId,
    side: 'BUY',
    orderType: 'MARKET',
    positionType: 'LONG',
    quantity: 1,
  };
  const [tradeA, tradeB] = await Promise.all([
    raw.trade.create({ data: { ...baseTrade, userId: userAId, notes: 'A-original' } }),
    raw.trade.create({ data: { ...baseTrade, userId: userBId, notes: 'B-original' } }),
  ]);
  tradeAId = tradeA.id;
  tradeBId = tradeB.id;

  const signal = await raw.signal.create({
    data: {
      instrumentId: instId,
      side: 'BUY',
      entryPrice: 100,
      targetPrice: 110,
      stoplossPrice: 95,
      expectedProfit: 10,
      expectedLoss: 5,
      riskRewardRatio: 2,
      confidence: 'HIGH',
      confidenceScore: 80,
      strategy: SIGNAL_STRATEGY,
      timeframe: '5m',
      reason: 'test',
    },
  });
  signalId = signal.id;
});

afterAll(async () => {
  await cleanup();
  await raw.$disconnect();
  await prisma.$disconnect();
});

const A = (): TenantContext => ({ userId: userAId, role: 'USER' });

describe('TDA-003 Task 2 — read isolation', () => {
  it('findMany returns ONLY tenant A rows', async () => {
    const trades = await asTenant(A(), () => prisma.trade.findMany());
    const ids = trades.map((t) => t.id);
    expect(ids).toContain(tradeAId);
    expect(ids).not.toContain(tradeBId);
    expect(trades.every((t) => t.userId === userAId)).toBe(true);
  });

  it('findUnique on OWN row returns the row', async () => {
    const t = await asTenant(A(), () =>
      prisma.trade.findUnique({ where: { id: tradeAId } }),
    );
    expect(t?.id).toBe(tradeAId);
  });

  it('findUnique on ANOTHER tenant row returns null (the gotcha)', async () => {
    const t = await asTenant(A(), () =>
      prisma.trade.findUnique({ where: { id: tradeBId } }),
    );
    expect(t).toBeNull();
  });
});

describe('TDA-003 Task 2 — write isolation', () => {
  it('update on OWN row succeeds and returns the record', async () => {
    const updated = await asTenant(A(), () =>
      prisma.trade.update({
        where: { id: tradeAId },
        data: { notes: 'A-updated' },
      }),
    );
    expect(updated.id).toBe(tradeAId);
    expect(updated.notes).toBe('A-updated');
  });

  it('update targeting ANOTHER tenant row never modifies it', async () => {
    await expect(
      asTenant(A(), () =>
        prisma.trade.update({
          where: { id: tradeBId },
          data: { notes: 'HACKED' },
        }),
      ),
    ).rejects.toBeDefined();

    const b = await raw.trade.findUnique({ where: { id: tradeBId } });
    expect(b?.notes).toBe('B-original');
  });

  it('delete targeting ANOTHER tenant row never removes it', async () => {
    await expect(
      asTenant(A(), () => prisma.trade.delete({ where: { id: tradeBId } })),
    ).rejects.toBeDefined();

    const b = await raw.trade.findUnique({ where: { id: tradeBId } });
    expect(b).not.toBeNull();
  });

  it('create stamps the context userId even when the payload spoofs another', async () => {
    const created = await asTenant(A(), () =>
      prisma.trade.create({
        data: {
          userId: userBId, // spoof attempt — context must win
          instrumentId: instId,
          side: 'BUY',
          orderType: 'MARKET',
          positionType: 'LONG',
          quantity: 1,
        },
      }),
    );
    const persisted = await raw.trade.findUnique({ where: { id: created.id } });
    expect(persisted?.userId).toBe(userAId);
    await raw.trade.delete({ where: { id: created.id } });
  });
});

describe('TDA-003 Task 2 — bypasses', () => {
  it('ADMIN context sees BOTH tenants rows', async () => {
    const trades = await asTenant({ userId: userAId, role: 'ADMIN' }, () =>
      prisma.trade.findMany(),
    );
    const ids = trades.map((t) => t.id);
    expect(ids).toContain(tradeAId);
    expect(ids).toContain(tradeBId);
  });

  it('NO context (background) sees BOTH tenants rows', async () => {
    // No cls.run at all — exactly how cron/queue/engine code runs.
    const trades = await prisma.trade.findMany();
    const ids = trades.map((t) => t.id);
    expect(ids).toContain(tradeAId);
    expect(ids).toContain(tradeBId);
  });
});

describe('TDA-003 Task 2 — global models are never scoped', () => {
  it('signal.findMany in tenant-A context returns rows (not scoped by userId)', async () => {
    const signals = await asTenant(A(), () =>
      prisma.signal.findMany({ where: { strategy: SIGNAL_STRATEGY } }),
    );
    expect(signals.map((s) => s.id)).toContain(signalId);
  });
});
