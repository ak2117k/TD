import { scoreAndCluster } from './sr-evidence-scoring';
import type { LevelCandidate } from '../types/evidence-level.types';

const ATR = 2;
const LTP = 100;

describe('scoreAndCluster', () => {
  it('keeps a candidate at/above the floor (35) and sides it correctly', () => {
    const cands: LevelCandidate[] = [{ price: 105, kind: 'VOLUME', score: 38 }];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [] });
    expect(out).toHaveLength(1);
    expect(out[0].side).toBe('resistance');
    expect(out[0].score).toBe(38);
    expect(out[0].kinds).toEqual(['VOLUME']);
    expect(out[0].soft).toBe(false);
    expect(out[0].distancePct).toBeCloseTo(5, 5);
  });

  it('drops a candidate below the floor (a naked round number)', () => {
    const cands: LevelCandidate[] = [{ price: 105, kind: 'ROUND', score: 12 }];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [] });
    expect(out.filter((l) => !l.soft)).toHaveLength(0);
  });

  it('clusters confluence: round + volume at the same price sum above floor', () => {
    const cands: LevelCandidate[] = [
      { price: 105, kind: 'ROUND', score: 12 },
      { price: 105.1, kind: 'VOLUME', score: 30 },
    ];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [] });
    const kept = out.filter((l) => !l.soft);
    expect(kept).toHaveLength(1);
    expect(kept[0].score).toBe(42);
    expect(kept[0].kinds.sort()).toEqual(['ROUND', 'VOLUME']);
  });

  it('caps cluster score at 100', () => {
    const cands: LevelCandidate[] = [
      { price: 105, kind: 'VOLUME', score: 40 },
      { price: 105, kind: 'HISTORY', score: 25 },
      { price: 105, kind: 'OI_CALL', score: 30 },
      { price: 105, kind: 'ROUND', score: 15 },
    ];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [] });
    expect(out[0].score).toBe(100);
  });

  it('adds a soft round number on a side that has no kept level', () => {
    const cands: LevelCandidate[] = [{ price: 95, kind: 'VOLUME', score: 38 }];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [90, 100, 110, 120] });
    const res = out.find((l) => l.side === 'resistance')!;
    expect(res.soft).toBe(true);
    expect(res.price).toBe(110);
    expect(res.kinds).toEqual(['ROUND']);
  });

  it('does not add a soft level when the side already has a kept level', () => {
    const cands: LevelCandidate[] = [{ price: 105, kind: 'VOLUME', score: 38 }];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [110, 120] });
    expect(out.filter((l) => l.side === 'resistance' && l.soft)).toHaveLength(0);
  });
});
