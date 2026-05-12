// apps/api/src/modules/chartink/services/chartink-scoring.service.spec.ts
import { Test, type TestingModule } from '@nestjs/testing';
import { ChartinkScoringService, type ScoringInput } from './chartink-scoring.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { NseSectorIndexService } from '../../market-data/services/nse-sector-index.service';

describe('ChartinkScoringService', () => {
  let service: ChartinkScoringService;
  let mockAdapter: { getHistoricalData: jest.Mock };
  let mockNseSectors: { getSectorIndexForSymbol: jest.Mock };

  beforeEach(async () => {
    mockAdapter = { getHistoricalData: jest.fn() };
    mockNseSectors = {
      getSectorIndexForSymbol: jest.fn((sym: string) => {
        const map: Record<string, string> = {
          RELIANCE: '99926019',
          TCS: '99926013',
          HDFCBANK: '99926009',
        };
        return map[sym.toUpperCase()] ?? null;
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChartinkScoringService,
        { provide: AngelOneAdapterService, useValue: mockAdapter },
        { provide: NseSectorIndexService, useValue: mockNseSectors },
      ],
    }).compile();
    module.useLogger(false);
    service = module.get(ChartinkScoringService);
    (service as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () => Promise.resolve();
  });

  describe('scoreToLotCount', () => {
    it.each([
      [0, 0], [49, 0], [50, 1], [64, 1], [65, 2], [79, 2], [80, 3], [100, 3],
    ])('score=%d → %d lots', (score, expected) => {
      expect(service.scoreToLotCount(score)).toBe(expected);
    });
  });

  describe('score()', () => {
    const baseInput: ScoringInput = {
      token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
      entryPrice: 2880, setupContext: null,
    };

    function rising(n: number, start: number, step: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: start + i * step, high: start + i * step + 0.5, low: start + i * step - 0.5,
        close: start + i * step + 0.25, volume: 1000 + i * 50,
      }));
    }
    function falling(n: number, start: number, step: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: start - i * step, high: start - i * step + 0.5, low: start - i * step - 0.5,
        close: start - i * step - 0.25, volume: 1000 + i * 50,
      }));
    }
    function flat(n: number, price: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: price, high: price + 0.1, low: price - 0.1,
        close: price, volume: 1000,
      }));
    }

    it('all checks rising → strong score with 10 checks (RELIANCE has sector mapping)', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(rising(60, 100, 0.5));
      const result = await service.score(baseInput);
      // With identical stock+sector data: Sector passes (10), RS fails — RS=0 doesn't satisfy
      // strict > 0 (0). Index passes (20), MACDs (10+7+8=25), Price vs EMA UP (10), ST UP (10),
      // S/R fails — no level book (0), Vol passes (5). Empirical total = 55.
      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.lotCount).toBeGreaterThanOrEqual(1);
      expect(result.checks.length).toBe(10);
    });

    it('all checks falling on BUY setup → low score', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(falling(60, 100, 0.5));
      const result = await service.score(baseInput);
      expect(result.score).toBeLessThan(50);
      expect(result.lotCount).toBe(0);
    });

    it('symbol with no sector mapping → sector + RS checks fail with reason', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(rising(60, 100, 0.5));
      const input: ScoringInput = { ...baseInput, symbol: 'UNKNOWNSTOCK' };
      const result = await service.score(input);
      const sectorCheck = result.checks.find((c) => c.name === 'Sector aligned');
      expect(sectorCheck?.passed).toBe(false);
      expect(sectorCheck?.detail?.reason).toBe('no sector mapping');
      const rsCheck = result.checks.find((c) => c.name === 'Relative strength');
      expect(rsCheck?.passed).toBe(false);
      expect(rsCheck?.detail?.reason).toBe('no sector mapping');
    });

    it('broker throws for first check → that check fails but others continue', async () => {
      // First call throws (sector check), rest succeed
      mockAdapter.getHistoricalData
        .mockRejectedValueOnce(new Error('Angel timeout'))
        .mockResolvedValue(rising(60, 100, 0.5));
      const result = await service.score(baseInput);
      expect(result.checks.length).toBe(10);
      const sector = result.checks.find((c) => c.name === 'Sector aligned');
      expect(sector?.detail?.error).toBe('Angel timeout');
    });
  });

  describe('checkRelativeStrength', () => {
    const buyInput: ScoringInput = {
      token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
      entryPrice: 2880, setupContext: null,
    };
    const sellInput: ScoringInput = { ...buyInput, side: 'SELL' };

    function rising(n: number, start: number, step: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: start + i * step, high: start + i * step + 0.5, low: start + i * step - 0.5,
        close: start + i * step + 0.25, volume: 1000 + i * 50,
      }));
    }

    it('BUY: stock outperforming sector → RS check passes', async () => {
      // Stock rises faster (step 1.0) than sector (step 0.2)
      // RELIANCE token = '2885', sector token = '99926019' (NIFTY ENERGY)
      const stockBars = rising(30, 100, 1.0);
      const sectorBars = rising(30, 100, 0.2);
      mockAdapter.getHistoricalData.mockImplementation(
        (token: string) => Promise.resolve(token === '2885' ? stockBars : sectorBars),
      );
      // Call checkRelativeStrength directly via the private path through score()
      // — but we only want to verify the RS check specifically.
      const result = await service.score(buyInput);
      const rs = result.checks.find((c) => c.name === 'Relative strength');
      expect(rs?.passed).toBe(true);
      expect(rs?.points).toBe(10);
      expect((rs?.detail?.rs as number)).toBeGreaterThan(0);
    });

    it('BUY: stock underperforming sector → RS check fails', async () => {
      // Stock rises slower (step 0.1) than sector (step 1.0)
      const stockBars = rising(30, 100, 0.1);
      const sectorBars = rising(30, 100, 1.0);
      mockAdapter.getHistoricalData.mockImplementation(
        (token: string) => Promise.resolve(token === '2885' ? stockBars : sectorBars),
      );
      const result = await service.score(buyInput);
      const rs = result.checks.find((c) => c.name === 'Relative strength');
      expect(rs?.passed).toBe(false);
      expect(rs?.points).toBe(0);
      expect((rs?.detail?.rs as number)).toBeLessThan(0);
    });

    it('SELL: stock underperforming sector → RS check passes', async () => {
      // Stock rises slower than sector — stock is relatively weak → SELL passes
      const stockBars = rising(30, 100, 0.1);
      const sectorBars = rising(30, 100, 1.0);
      mockAdapter.getHistoricalData.mockImplementation(
        (token: string) => Promise.resolve(token === '2885' ? stockBars : sectorBars),
      );
      const result = await service.score(sellInput);
      const rs = result.checks.find((c) => c.name === 'Relative strength');
      expect(rs?.passed).toBe(true);
      expect(rs?.points).toBe(10);
    });

    it('no sector mapping → RS check fails with reason: "no sector mapping"', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(rising(30, 100, 0.5));
      const input: ScoringInput = { ...buyInput, symbol: 'UNKNOWNSTOCK' };
      const result = await service.score(input);
      const rs = result.checks.find((c) => c.name === 'Relative strength');
      expect(rs?.passed).toBe(false);
      expect(rs?.detail?.reason).toBe('no sector mapping');
    });
  });

  describe('classifyTrend (via Price vs 20-EMA check)', () => {
    const buyInput: ScoringInput = {
      token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
      entryPrice: 2880, setupContext: null,
    };
    const sellInput: ScoringInput = { ...buyInput, side: 'SELL' };

    function rising(n: number, start: number, step: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: start + i * step, high: start + i * step + 0.5, low: start + i * step - 0.5,
        close: start + i * step + 0.25, volume: 1000 + i * 50,
      }));
    }
    function falling(n: number, start: number, step: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: start - i * step, high: start - i * step + 0.5, low: start - i * step - 0.5,
        close: start - i * step - 0.25, volume: 1000 + i * 50,
      }));
    }
    function flat(n: number, price: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: price, high: price + 0.1, low: price - 0.1,
        close: price, volume: 1000,
      }));
    }

    it('rising closes → UP → Price vs 20-EMA passes for BUY', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(rising(60, 100, 0.5));
      const result = await service.score(buyInput);
      const check = result.checks.find((c) => c.name === 'Price vs 20-EMA');
      expect(check?.passed).toBe(true);
      expect(check?.detail?.trend).toBe('UP');
    });

    it('falling closes → DOWN → Price vs 20-EMA passes for SELL', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(falling(60, 100, 0.5));
      const result = await service.score(sellInput);
      const check = result.checks.find((c) => c.name === 'Price vs 20-EMA');
      expect(check?.passed).toBe(true);
      expect(check?.detail?.trend).toBe('DOWN');
    });

    it('flat closes (EMA flat, price hovering) → INDETERMINATE → fails for BUY', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(flat(60, 100));
      const result = await service.score(buyInput);
      const check = result.checks.find((c) => c.name === 'Price vs 20-EMA');
      expect(check?.passed).toBe(false);
      expect(check?.detail?.trend).toBe('INDETERMINATE');
    });

    it('flat closes → INDETERMINATE → fails for SELL too', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(flat(60, 100));
      const result = await service.score(sellInput);
      const check = result.checks.find((c) => c.name === 'Price vs 20-EMA');
      expect(check?.passed).toBe(false);
      expect(check?.detail?.trend).toBe('INDETERMINATE');
    });
  });
});
