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

  it('caps at 5 nodes per side (<= 10 total)', () => {
    const candles: ProfileCandle[] = [];
    for (let i = 0; i < 40; i++) candles.push(c(100 + i, 10 + i));
    const ltp = 120;
    const nodes = computeVolumeNodes(candles, 1, ltp);
    expect(nodes.length).toBeLessThanOrEqual(10);
    expect(nodes.filter((n) => n.price > ltp).length).toBeLessThanOrEqual(5);
    expect(nodes.filter((n) => n.price < ltp).length).toBeLessThanOrEqual(5);
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

  it('all volume above LTP → returns above-side nodes, none invented below', () => {
    const candles: ProfileCandle[] = [];
    for (const p of [210, 220, 230, 240, 250]) {
      for (let i = 0; i < 4; i++) candles.push(c(p, 300));
    }
    const ltp = 200;
    const nodes = computeVolumeNodes(candles, 5, ltp);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((n) => n.price > ltp)).toBe(true);
  });

  it('surfaces a below-LTP node even when the top-5 volume buckets are all above LTP', () => {
    const candles: ProfileCandle[] = [];
    // Five heavy shelves ABOVE ltp (200): 210..250, volumes 500..900 — these are
    // the global top-5 by volume.
    for (const p of [210, 220, 230, 240, 250]) {
      for (let i = 0; i < 6; i++) candles.push(c(p, 500 + (p - 210) * 10));
    }
    // One lighter-but-real shelf BELOW ltp at 180 (volume 100 each) — never in
    // the global top-5, but the strongest node on the support side.
    for (let i = 0; i < 6; i++) candles.push(c(180, 100));

    const nodes = computeVolumeNodes(candles, 5, 200);

    // Global top-5 would be all-above; per-side selection must keep the 180 shelf.
    expect(nodes.some((n) => n.price < 200)).toBe(true);
    expect(nodes.some((n) => Math.round(n.price) === 180)).toBe(true);
  });
});
