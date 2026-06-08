import { describe, it, expect } from 'vitest';
import type { StrongZone } from '@/types';
import { buildSRView, type LevelBookLite } from './buildSRView';

function zone(p: Partial<StrongZone> & {
  type: 'support' | 'resistance';
  classification: 'STRONG' | 'MEDIUM' | 'WEAK';
  upper: number; lower: number;
}): StrongZone {
  return {
    id: `${p.type}-${p.upper}`, token: '1', symbol: 'T', exchange: 'NSE',
    isLine: p.isLine ?? true, strength: p.strength ?? 50, touchCount: 3,
    lastTouchTimestamp: 0,
    scoreBreakdown: { touchCount: 0, reversalScore: 0, volumeScore: 0, recencyScore: 0, confluenceBonus: 0, wickDensity: 0 },
    computedAt: 0, expiresAt: 0, ...p,
  };
}

const emptyBook: LevelBookLite = {
  pdh: null, pdl: null, orh: null, orl: null, prevOrh: null, prevOrl: null, vwap: 0,
};

describe('buildSRView', () => {
  it('returns empty view when ltp <= 0', () => {
    const v = buildSRView({ ...emptyBook, pdh: 110 }, [], 0);
    expect(v.immediateResistance).toBeNull();
    expect(v.immediateSupport).toBeNull();
    expect(v.levels).toEqual([]);
  });

  it('anchored-only (no zones) still yields immediate R and S', () => {
    const book: LevelBookLite = { ...emptyBook, pdh: 110, pdl: 90, vwap: 105 };
    const v = buildSRView(book, [], 100);
    expect(v.immediateResistance?.price).toBe(105);
    expect(v.immediateResistance?.source).toBe('VWAP');
    expect(v.immediateSupport?.price).toBe(90);
    expect(v.immediateSupport?.source).toBe('PDL');
  });

  it('signs distancePct: + above, - below', () => {
    const v = buildSRView({ ...emptyBook, pdh: 102, pdl: 98 }, [], 100);
    expect(v.immediateResistance?.distancePct).toBeCloseTo(2, 5);
    expect(v.immediateSupport?.distancePct).toBeCloseTo(-2, 5);
  });

  it('nearest can be a pivot zone (mixes sources)', () => {
    const book: LevelBookLite = { ...emptyBook, pdh: 120 };
    const piv = zone({ type: 'resistance', classification: 'MEDIUM', upper: 105, lower: 105 });
    const v = buildSRView(book, [piv], 100);
    expect(v.immediateResistance?.source).toBe('PIVOT');
    expect(v.immediateResistance?.price).toBe(105);
  });

  it('uses pivot reachable edge: lower for resistance, upper for support', () => {
    const res = zone({ type: 'resistance', classification: 'MEDIUM', upper: 115, lower: 110, isLine: false });
    const v = buildSRView(emptyBook, [res], 100);
    expect(v.immediateResistance?.price).toBe(110);
  });

  it('includes a flipped (forming) WEAK pivot but excludes non-flipped WEAK', () => {
    const formingSup = zone({ type: 'support', classification: 'WEAK', upper: 95, lower: 95, flippedAt: 1, wasType: 'resistance' });
    const noiseSup = zone({ type: 'support', classification: 'WEAK', upper: 96, lower: 96 });
    const v = buildSRView(emptyBook, [formingSup, noiseSup], 100);
    expect(v.immediateSupport?.price).toBe(95);
    expect(v.levels.some((l) => l.source === 'PIVOT' && l.price === 96)).toBe(false);
  });

  it('major tier = STRONG pivots + PDH/PDL (non-immediate)', () => {
    const book: LevelBookLite = { ...emptyBook, pdh: 130, pdl: 70, vwap: 101 };
    const strongRes = zone({ type: 'resistance', classification: 'STRONG', upper: 120, lower: 120 });
    const v = buildSRView(book, [strongRes], 100);
    const pdh = v.levels.find((l) => l.source === 'PDH')!;
    const strong = v.levels.find((l) => l.source === 'PIVOT')!;
    expect(pdh.tier).toBe('major');
    expect(strong.tier).toBe('major');
    expect(v.immediateResistance?.source).toBe('VWAP');
  });

  it('falls back to prevOrh/prevOrl when orh/orl are null, labelled ORH/ORL', () => {
    const book: LevelBookLite = { ...emptyBook, orh: null, orl: null, prevOrh: 108, prevOrl: 92 };
    const v = buildSRView(book, [], 100);
    expect(v.immediateResistance?.source).toBe('ORH');
    expect(v.immediateResistance?.price).toBe(108);
    expect(v.immediateSupport?.source).toBe('ORL');
    expect(v.immediateSupport?.price).toBe(92);
  });

  it('one-sided: only resistances above → immediateSupport null', () => {
    const v = buildSRView({ ...emptyBook, pdh: 110, orh: 120 }, [], 100);
    expect(v.immediateResistance).not.toBeNull();
    expect(v.immediateSupport).toBeNull();
  });

  it('dedupes anchored vs pivot at the same price (keeps anchored label)', () => {
    const book: LevelBookLite = { ...emptyBook, pdh: 110 };
    const pivAtPdh = zone({ type: 'resistance', classification: 'MEDIUM', upper: 110, lower: 110 });
    const v = buildSRView(book, [pivAtPdh], 100);
    const at110 = v.levels.filter((l) => Math.abs(l.price - 110) < 0.01);
    expect(at110).toHaveLength(1);
    expect(at110[0].source).toBe('PDH');
  });
});
