import { Injectable } from '@nestjs/common';

export interface LevelBookSnapshot {
  pdh: number;
  pdl: number;
  orh: number | null;
  orl: number | null;
  vwap: number;
  vwapStddev: number | null;
}

export interface TargetResult {
  target: number;
  source: 'indicator-sr' | 'fallback-10pct';
}

@Injectable()
export class TargetCalculatorService {
  /**
   * BUY: closest resistance above entry within [entry*1.02, entry*1.10].
   *      Candidates: PDH, ORH, VWAP + 1σ. Fallback: entry × 1.10.
   * SELL: mirrored — closest support below within [entry*0.90, entry*0.98].
   *       Candidates: PDL, ORL, VWAP − 1σ. Fallback: entry × 0.90.
   * Returns fallback directly when levelBook is null.
   */
  compute(input: {
    side: 'BUY' | 'SELL';
    entryPrice: number;
    levelBook: LevelBookSnapshot | null;
  }): TargetResult {
    const { side, entryPrice, levelBook } = input;

    if (!levelBook) {
      return {
        target: side === 'BUY' ? entryPrice * 1.10 : entryPrice * 0.90,
        source: 'fallback-10pct',
      };
    }

    const stddev = levelBook.vwapStddev ?? 0;

    if (side === 'BUY') {
      const lowerBound = entryPrice * 1.02;
      const upperBound = entryPrice * 1.10;
      const candidates: number[] = [];
      if (levelBook.pdh != null) candidates.push(levelBook.pdh);
      if (levelBook.orh != null) candidates.push(levelBook.orh);
      candidates.push(levelBook.vwap + stddev);
      const inRange = candidates.filter((v) => v >= lowerBound && v <= upperBound);
      if (inRange.length === 0) {
        return { target: entryPrice * 1.10, source: 'fallback-10pct' };
      }
      return { target: Math.min(...inRange), source: 'indicator-sr' };
    } else {
      const lowerBound = entryPrice * 0.90;
      const upperBound = entryPrice * 0.98;
      const candidates: number[] = [];
      if (levelBook.pdl != null) candidates.push(levelBook.pdl);
      if (levelBook.orl != null) candidates.push(levelBook.orl);
      candidates.push(levelBook.vwap - stddev);
      const inRange = candidates.filter((v) => v >= lowerBound && v <= upperBound);
      if (inRange.length === 0) {
        return { target: entryPrice * 0.90, source: 'fallback-10pct' };
      }
      return { target: Math.max(...inRange), source: 'indicator-sr' };
    }
  }
}
