import { OiWallService } from './oi-wall.service';

describe('OiWallService', () => {
  const chain = [
    { strikePrice: 100, ceData: { oi: 10 }, peData: { oi: 90 } },
    { strikePrice: 110, ceData: { oi: 80 }, peData: { oi: 20 } },
    { strikePrice: 120, ceData: { oi: 50 }, peData: { oi: 5 } },
    { strikePrice: 90, ceData: { oi: 5 }, peData: { oi: 70 } },
  ];

  function svc(getExpiries: jest.Mock, getOptionsChain: jest.Mock) {
    return new OiWallService({ getExpiries, getOptionsChain } as never);
  }

  it('returns [] for a non-F&O symbol (no expiries)', async () => {
    const s = svc(jest.fn().mockResolvedValue([]), jest.fn());
    expect(await s.walls('CUPID', 105)).toEqual([]);
  });

  it('returns top-2 call strikes as resistance (score 30/20) and top-2 put strikes as support', async () => {
    const s = svc(
      jest.fn().mockResolvedValue(['2026-06-25']),
      jest.fn().mockResolvedValue(chain),
    );
    const walls = await s.walls('NIFTY', 105);
    const res = walls.filter((w) => w.kind === 'OI_CALL').sort((a, b) => b.score - a.score);
    const sup = walls.filter((w) => w.kind === 'OI_PUT').sort((a, b) => b.score - a.score);
    expect(res[0]).toMatchObject({ price: 110, score: 30 });
    expect(res[1]).toMatchObject({ price: 120, score: 20 });
    expect(sup[0]).toMatchObject({ price: 100, score: 30 });
    expect(sup[1]).toMatchObject({ price: 90, score: 20 });
  });

  it('returns [] and does not throw when the chain fetch fails', async () => {
    const s = svc(
      jest.fn().mockResolvedValue(['2026-06-25']),
      jest.fn().mockRejectedValue(new Error('boom')),
    );
    expect(await s.walls('NIFTY', 105)).toEqual([]);
  });

  it('excludes ITM high-OI strikes (call below spot / put above spot) — only OTM walls count', async () => {
    const ltp = 105;
    const itmChain = [
      ...chain,
      { strikePrice: 95, ceData: { oi: 999 }, peData: { oi: 1 } },  // ITM call, huge OI — must be excluded
      { strikePrice: 115, ceData: { oi: 1 }, peData: { oi: 999 } }, // ITM put, huge OI — must be excluded
    ];
    const s = svc(
      jest.fn().mockResolvedValue(['2026-06-25']),
      jest.fn().mockResolvedValue(itmChain),
    );
    const walls = await s.walls('NIFTY', ltp);
    // No call wall below spot, no put wall above spot.
    expect(walls.filter((w) => w.kind === 'OI_CALL').every((w) => w.price > ltp)).toBe(true);
    expect(walls.filter((w) => w.kind === 'OI_PUT').every((w) => w.price < ltp)).toBe(true);
    // The 999-OI ITM strikes are dropped despite being the highest OI.
    expect(walls.some((w) => w.price === 95)).toBe(false);
    expect(walls.some((w) => w.price === 115)).toBe(false);
    // Genuine OTM walls remain the chosen ones.
    expect(walls.find((w) => w.kind === 'OI_CALL')).toMatchObject({ price: 110, score: 30 });
    expect(walls.find((w) => w.kind === 'OI_PUT')).toMatchObject({ price: 100, score: 30 });
  });
});
