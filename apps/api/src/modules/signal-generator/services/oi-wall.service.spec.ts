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
    expect(await s.walls('CUPID')).toEqual([]);
  });

  it('returns top-2 call strikes as resistance (score 30/20) and top-2 put strikes as support', async () => {
    const s = svc(
      jest.fn().mockResolvedValue(['2026-06-25']),
      jest.fn().mockResolvedValue(chain),
    );
    const walls = await s.walls('NIFTY');
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
    expect(await s.walls('NIFTY')).toEqual([]);
  });
});
