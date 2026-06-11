import { detectSwingPivots, type PivotCandle } from './swing-pivots';

const mk = (h: number, l: number): PivotCandle => ({ high: h, low: l });

describe('detectSwingPivots', () => {
  it('detects an obvious swing high and swing low with correct kind and price', () => {
    // Flat baseline, with a clear swing HIGH spike at index 7 and a clear
    // swing LOW dip at index 14. Both have 3+ bars of context on each side.
    const candles: PivotCandle[] = [];
    for (let i = 0; i < 22; i++) {
      candles.push(mk(100, 99));
    }
    candles[7] = mk(110, 99); // swing high spike
    candles[14] = mk(100, 90); // swing low dip

    const pivots = detectSwingPivots(candles);

    const high = pivots.find((p) => p.kind === 'high');
    const low = pivots.find((p) => p.kind === 'low');

    expect(high).toBeTruthy();
    expect(high!.price).toBe(110);
    expect(low).toBeTruthy();
    expect(low!.price).toBe(90);
  });

  it('skips the first and last 3 bars (unconfirmed edges)', () => {
    const candles: PivotCandle[] = [];
    for (let i = 0; i < 10; i++) candles.push(mk(100, 99));
    candles[1] = mk(120, 99); // too close to the start — cannot confirm
    candles[9] = mk(120, 99); // last bar — cannot confirm
    const pivots = detectSwingPivots(candles);
    expect(pivots).toEqual([]);
  });
});
