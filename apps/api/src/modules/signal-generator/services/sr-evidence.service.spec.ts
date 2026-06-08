import { SrEvidenceService } from './sr-evidence.service';

describe('SrEvidenceService', () => {
  const book = { spot: 140, atr14: 4, pdh: 138, pdl: 130 };
  const candles = Array.from({ length: 20 }, (_, i) => ({
    high: 150, low: 150, close: 150, volume: i < 10 ? 500 : 50,
  }));

  function build(overrides: Partial<any> = {}) {
    const deps = {
      levelBookService: { lazyLoad: jest.fn().mockResolvedValue(book) },
      angelOneAdapter: { getHistoricalData: jest.fn().mockResolvedValue(candles) },
      marketDataRepository: {
        getInstrumentByToken: jest.fn().mockResolvedValue({ id: 'i1', symbol: 'CUPID', exchange: 'NSE' }),
        getCandles: jest.fn().mockResolvedValue([]),
      },
      zoneRepository: { findActiveByToken: jest.fn().mockResolvedValue([]) },
      oiWallService: { walls: jest.fn().mockResolvedValue([]) },
      ...overrides,
    };
    return new SrEvidenceService(
      deps.levelBookService as never,
      deps.angelOneAdapter as never,
      deps.marketDataRepository as never,
      deps.zoneRepository as never,
      deps.oiWallService as never,
    );
  }

  it('returns [] when no level book (insufficient data)', async () => {
    const s = build({ levelBookService: { lazyLoad: jest.fn().mockResolvedValue(null) } });
    expect(await s.levelsFor('18520', 'NSE', 'CUPID')).toEqual([]);
  });

  it('produces a scored resistance from a volume node above spot', async () => {
    const s = build();
    const levels = await s.levelsFor('18520', 'NSE', 'CUPID');
    const res = levels.find((l) => l.side === 'resistance' && !l.soft);
    expect(res).toBeTruthy();
    expect(res!.kinds).toContain('VOLUME');
  });

  it('includes OI walls when the symbol is F&O', async () => {
    const s = build({
      oiWallService: { walls: jest.fn().mockResolvedValue([{ price: 145, kind: 'OI_CALL', score: 30 }]) },
    });
    const levels = await s.levelsFor('99926000', 'NSE', 'NIFTY');
    expect(levels.some((l) => l.kinds.includes('OI_CALL'))).toBe(true);
  });
});
