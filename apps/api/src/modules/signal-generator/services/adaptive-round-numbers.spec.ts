import { adaptiveRoundStep, adaptiveRoundNumbers, roundScore } from './adaptive-round-numbers';

describe('adaptiveRoundNumbers', () => {
  it('picks a price-tiered step', () => {
    expect(adaptiveRoundStep(30)).toBe(1);
    expect(adaptiveRoundStep(140)).toBe(5);
    expect(adaptiveRoundStep(380)).toBe(10);
    expect(adaptiveRoundStep(1500)).toBe(25);
    expect(adaptiveRoundStep(3000)).toBe(50);
    expect(adaptiveRoundStep(9000)).toBe(100);
  });

  it('generates ±3 steps around spot on the grid', () => {
    expect(adaptiveRoundNumbers(140)).toEqual([125, 130, 135, 140, 145, 150, 155]);
  });

  it('roundScore: 12 for grid membership, 15 for a major round (multiple of 5*step)', () => {
    expect(roundScore(140, 5)).toBe(12);
    expect(roundScore(150, 5)).toBe(15);
    expect(roundScore(141, 5)).toBe(0);
  });

  it('returns [] for non-positive ltp', () => {
    expect(adaptiveRoundNumbers(0)).toEqual([]);
    expect(adaptiveRoundNumbers(-5)).toEqual([]);
  });
});
