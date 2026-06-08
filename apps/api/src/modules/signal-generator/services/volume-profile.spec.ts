import { computeVolumeNodes, type ProfileCandle } from './volume-profile';

function c(close: number, volume: number): ProfileCandle {
  return { high: close, low: close, close, volume };
}

describe('computeVolumeNodes', () => {
  it('returns [] for fewer than 10 candles', () => {
    expect(computeVolumeNodes([c(100, 5)], 2, 100)).toEqual([]);
  });

  it('surfaces the highest-volume price bucket as a node with score', () => {
    const candles: ProfileCandle[] = [];
    for (let i = 0; i < 16; i++) candles.push(c(120 + (i % 3), 10));
    for (let i = 0; i < 8; i++) candles.push(c(150, 300));
    const nodes = computeVolumeNodes(candles, 2, 145);
    expect(nodes.length).toBeGreaterThan(0);
    expect(Math.round(nodes[0].price)).toBe(150);
    // The 150 shelf is >=3x the average bucket volume → full 40.
    expect(nodes[0].score).toBe(40);
  });

  it('caps at 5 nodes', () => {
    const candles: ProfileCandle[] = [];
    for (let i = 0; i < 40; i++) candles.push(c(100 + i, 10 + i));
    const nodes = computeVolumeNodes(candles, 1, 120);
    expect(nodes.length).toBeLessThanOrEqual(5);
  });

  it('boundary: 9 candles → [], 10 candles → non-empty', () => {
    const nine = Array.from({ length: 9 }, () => c(100, 50));
    expect(computeVolumeNodes(nine, 2, 100)).toEqual([]);
    const ten = Array.from({ length: 10 }, (_, i) => c(100 + (i % 4), 50));
    expect(computeVolumeNodes(ten, 2, 100).length).toBeGreaterThan(0);
  });

  it('all-zero volume → nodes returned with score 0 (no div-by-zero)', () => {
    const candles = Array.from({ length: 12 }, (_, i) => c(100 + (i % 3), 0));
    const nodes = computeVolumeNodes(candles, 2, 100);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((n) => n.score === 0)).toBe(true);
  });
});
