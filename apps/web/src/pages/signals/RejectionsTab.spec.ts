import { describe, it, expect } from 'vitest';
import { buildKindBreakdown, acceptanceRate } from './RejectionsTab';

describe('buildKindBreakdown', () => {
  it('returns rows sorted by count descending with bar pct relative to the max', () => {
    const rows = buildKindBreakdown([
      { kind: 'mtf-misaligned', count: 18 },
      { kind: 'no-direction', count: 31 },
      { kind: 'scored-low', count: 9 },
    ]);

    expect(rows.map((r) => r.kind)).toEqual([
      'no-direction',
      'mtf-misaligned',
      'scored-low',
    ]);
    // top row is 100% of the bar
    expect(rows[0].pct).toBe(100);
    // 18/31 ≈ 58
    expect(rows[1].pct).toBe(58);
    // 9/31 ≈ 29
    expect(rows[2].pct).toBe(29);
  });

  it('handles an empty list without dividing by zero', () => {
    expect(buildKindBreakdown([])).toEqual([]);
  });

  it('handles all-zero counts without NaN bar widths', () => {
    const rows = buildKindBreakdown([{ kind: 'error', count: 0 }]);
    expect(rows[0].pct).toBe(0);
    expect(Number.isNaN(rows[0].pct)).toBe(false);
  });
});

describe('acceptanceRate', () => {
  it('computes accepted / totalProcessed as a whole-number percentage', () => {
    expect(acceptanceRate({ totalProcessed: 50, accepted: 12, rejected: 38, byKind: [] })).toBe(
      24,
    );
  });

  it('returns 0 when nothing was processed', () => {
    expect(acceptanceRate({ totalProcessed: 0, accepted: 0, rejected: 0, byKind: [] })).toBe(0);
  });
});
