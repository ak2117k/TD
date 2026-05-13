import { TargetCalculatorService } from './target-calculator.service';

describe('TargetCalculatorService', () => {
  let svc: TargetCalculatorService;

  beforeEach(() => {
    svc = new TargetCalculatorService();
  });

  describe('BUY side', () => {
    it('picks closest in-range resistance above entry', () => {
      const r = svc.compute({
        side: 'BUY',
        entryPrice: 100,
        levelBook: { pdh: 105, pdl: 95, orh: 103, orl: 98, vwap: 100, vwapStddev: 1 },
      });
      expect(r.target).toBeCloseTo(103);
      expect(r.source).toBe('indicator-sr');
    });

    it('falls back to 10% when no level fits in range', () => {
      const r = svc.compute({
        side: 'BUY',
        entryPrice: 100,
        levelBook: { pdh: 200, pdl: 95, orh: 250, orl: 98, vwap: 100, vwapStddev: 50 },
      });
      expect(r.target).toBeCloseTo(110);
      expect(r.source).toBe('fallback-10pct');
    });

    it('falls back when levelBook is null', () => {
      const r = svc.compute({ side: 'BUY', entryPrice: 100, levelBook: null });
      expect(r.target).toBeCloseTo(110);
      expect(r.source).toBe('fallback-10pct');
    });
  });

  describe('SELL side', () => {
    it('picks closest in-range support below entry', () => {
      const r = svc.compute({
        side: 'SELL',
        entryPrice: 100,
        levelBook: { pdh: 105, pdl: 97, orh: 103, orl: 95, vwap: 100, vwapStddev: 1 },
      });
      expect(r.target).toBeCloseTo(97);
      expect(r.source).toBe('indicator-sr');
    });

    it('falls back to -10% when no level fits', () => {
      const r = svc.compute({
        side: 'SELL',
        entryPrice: 100,
        levelBook: { pdh: 105, pdl: 50, orh: 103, orl: 40, vwap: 100, vwapStddev: 50 },
      });
      expect(r.target).toBeCloseTo(90);
      expect(r.source).toBe('fallback-10pct');
    });
  });
});
