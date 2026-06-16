import {
  evaluateDecisionGate, detectSwingPivots, roundGrid, rsi, type GateCandle,
} from './adaptive-stop-decision-gate';

const PARAMS = { nearSupportPct: 0.6, rsiHot: 70, vwapExtPct: 1.5 };

// Build a same-IST-day 15m series from {h,l,c} rows starting 09:15 IST
// (03:45Z). `nowMs` is set just after the last candle closes so every bar
// counts as "closed before now".
function series(rows: { h: number; l: number; c: number }[]) {
  const base = new Date('2026-06-15T03:45:00.000Z').getTime();
  const candles: GateCandle[] = rows.map((r, i) => ({
    timestamp: new Date(base + i * 15 * 60_000),
    high: r.h, low: r.l, close: r.c, volume: 1000,
  }));
  const nowMs = base + rows.length * 15 * 60_000 + 60_000;
  return { candles, nowMs };
}

// A V-shaped session: a clean 3-bar swing low at index 6 (low 96), VWAP ≈ 99.
const V_ROWS = [
  { h: 100, l: 99, c: 99.5 }, { h: 100, l: 99, c: 99.5 }, { h: 99, l: 98, c: 98.5 },
  { h: 99, l: 98, c: 98.5 }, { h: 98, l: 97, c: 97.5 }, { h: 98, l: 97, c: 97.5 },
  { h: 97, l: 96, c: 96.5 }, // <- swing low @96
  { h: 98, l: 97, c: 97.5 }, { h: 99, l: 98, c: 98.5 }, { h: 99, l: 98, c: 98.5 },
  { h: 100, l: 99, c: 99.5 }, { h: 100, l: 99, c: 99.5 }, { h: 101, l: 100, c: 100.5 },
  { h: 101, l: 100, c: 100.5 }, { h: 102, l: 101, c: 101.5 }, { h: 102, l: 101, c: 101.5 },
];

describe('decision-gate primitives', () => {
  it('detectSwingPivots finds the 3-bar fractal swing low', () => {
    const { candles } = series(V_ROWS);
    const piv = detectSwingPivots(candles);
    expect(piv.some((p) => p.kind === 'low' && p.price === 96)).toBe(true);
  });
  it('roundGrid is price-adaptive around the spot', () => {
    expect(roundGrid(96.3)).toEqual(expect.arrayContaining([95, 100]));
  });
  it('rsi returns null below period+1 and ~100 on a monotonic rise', () => {
    expect(rsi([1, 2, 3])).toBeNull();
    expect(rsi(Array.from({ length: 20 }, (_, i) => 100 + i))).toBeCloseTo(100, 0);
  });
});

describe('evaluateDecisionGate (CORE2)', () => {
  it('SKIPS (fails open) when there are too few candles', () => {
    const { candles, nowMs } = series(V_ROWS.slice(0, 4));
    const r = evaluateDecisionGate(98, candles, nowMs, PARAMS);
    expect(r.skipped).toBe(true);
    expect(r.pass).toBe(true);
  });

  it('PASSES when entry is at support and not extended', () => {
    const { candles, nowMs } = series(V_ROWS);
    const r = evaluateDecisionGate(96.3, candles, nowMs, PARAMS); // 0.3% above the 96 swing low
    expect(r.nearSupport).toBe(true);
    expect(r.notExtended).toBe(true); // below VWAP ⇒ not extended
    expect(r.pass).toBe(true);
  });

  it('REJECTS when entry is far above support (not at support)', () => {
    const { candles, nowMs } = series(V_ROWS);
    const r = evaluateDecisionGate(100, candles, nowMs, PARAMS); // ~4% above nearest support
    expect(r.nearSupport).toBe(false);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/not-at-support/);
  });

  it('REJECTS when entry is extended above VWAP (chasing the top)', () => {
    const { candles, nowMs } = series(V_ROWS);
    const r = evaluateDecisionGate(101.5, candles, nowMs, PARAMS); // top of range, >1.5% above VWAP
    expect(r.notExtended).toBe(false);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/extended/);
  });
});
