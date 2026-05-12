// apps/api/src/modules/chartink/services/chartink-scoring.service.spec.ts
import { Test, type TestingModule } from '@nestjs/testing';
import { ChartinkScoringService, type ScoringInput } from './chartink-scoring.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

describe('ChartinkScoringService', () => {
  let service: ChartinkScoringService;
  let mockAdapter: { getHistoricalData: jest.Mock };

  beforeEach(async () => {
    mockAdapter = { getHistoricalData: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChartinkScoringService,
        { provide: AngelOneAdapterService, useValue: mockAdapter },
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

    it('all checks rising → score around 73 (RELIANCE has sector mapping)', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(rising(60, 100, 0.5));
      const result = await service.score(baseInput);
      expect(result.score).toBeGreaterThanOrEqual(60);
      expect(result.lotCount).toBeGreaterThanOrEqual(1);
      expect(result.checks.length).toBe(9);
    });

    it('all checks falling on BUY setup → low score', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(falling(60, 100, 0.5));
      const result = await service.score(baseInput);
      expect(result.score).toBeLessThan(50);
      expect(result.lotCount).toBe(0);
    });

    it('symbol with no sector mapping → sector check fails with reason', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(rising(60, 100, 0.5));
      const input: ScoringInput = { ...baseInput, symbol: 'UNKNOWNSTOCK' };
      const result = await service.score(input);
      const sectorCheck = result.checks.find((c) => c.name === 'Sector aligned');
      expect(sectorCheck?.passed).toBe(false);
      expect(sectorCheck?.detail?.reason).toBe('no sector mapping');
    });

    it('broker throws for one check → that check fails but others continue', async () => {
      // First call throws (sector), rest succeed
      mockAdapter.getHistoricalData
        .mockRejectedValueOnce(new Error('Angel timeout'))
        .mockResolvedValue(rising(60, 100, 0.5));
      const result = await service.score(baseInput);
      expect(result.checks.length).toBe(9);
      const sector = result.checks.find((c) => c.name === 'Sector aligned');
      expect(sector?.detail?.error).toBe('Angel timeout');
    });
  });
});
