// apps/api/src/modules/chartink/services/chartink-scoring.service.spec.ts
import { Test, type TestingModule } from '@nestjs/testing';
import { ChartinkScoringService, type ScoringInput } from './chartink-scoring.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { NseSectorIndexService } from '../../market-data/services/nse-sector-index.service';
import { macd } from '../../signal-generator/strategies/indicators';

describe('ChartinkScoringService', () => {
  let service: ChartinkScoringService;
  let mockAdapter: { getHistoricalData: jest.Mock };
  let mockNseSectors: { getSectorIndexForSymbol: jest.Mock };

  beforeEach(async () => {
    mockAdapter = { getHistoricalData: jest.fn() };
    mockNseSectors = {
      getSectorIndexForSymbol: jest.fn((sym: string) => {
        const map: Record<string, string> = {
          RELIANCE: '99926019',
          TCS: '99926013',
          HDFCBANK: '99926009',
        };
        return Promise.resolve(map[sym.toUpperCase()] ?? null);
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChartinkScoringService,
        { provide: AngelOneAdapterService, useValue: mockAdapter },
        { provide: NseSectorIndexService, useValue: mockNseSectors },
      ],
    }).compile();
    module.useLogger(false);
    service = module.get(ChartinkScoringService);
    (service as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () => Promise.resolve();
  });

  describe('scoreToLotCount', () => {
    it.each([
      [0, 0], [49, 0], [50, 1], [64, 1], [65, 2], [79, 2], [80, 3], [100, 3],
    ])('score=%d → %d lots', (score, expected) => {
      expect(service.scoreToLotCount(score)).toBe(expected);
    });
  });

  describe('score()', () => {
    const baseInput: ScoringInput = {
      token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
      entryPrice: 2880, setupContext: null,
    };

    function rising(n: number, start: number, step: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: start + i * step, high: start + i * step + 0.5, low: start + i * step - 0.5,
        close: start + i * step + 0.25, volume: 1000 + i * 50,
      }));
    }
    function falling(n: number, start: number, step: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: start - i * step, high: start - i * step + 0.5, low: start - i * step - 0.5,
        close: start - i * step - 0.25, volume: 1000 + i * 50,
      }));
    }
    function flat(n: number, price: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: price, high: price + 0.1, low: price - 0.1,
        close: price, volume: 1000,
      }));
    }

    it('all checks rising → strong score with 10 checks (RELIANCE has sector mapping)', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(rising(60, 100, 0.5));
      const result = await service.score(baseInput);
      // With identical stock+sector data: Sector passes (10), RS fails — RS=0 doesn't satisfy
      // strict > 0 (0). Index passes (20), MACDs (10+7+8=25), Price vs EMA UP (10), ST UP (10),
      // S/R fails — no level book (0), Vol passes (5). Empirical total = 55.
      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.lotCount).toBeGreaterThanOrEqual(1);
      expect(result.checks.length).toBe(10);
    });

    it('all checks falling on BUY setup → low score', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(falling(60, 100, 0.5));
      const result = await service.score(baseInput);
      expect(result.score).toBeLessThan(50);
      expect(result.lotCount).toBe(0);
    });

    it('symbol with no sector mapping → sector + RS checks fail with reason', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(rising(60, 100, 0.5));
      const input: ScoringInput = { ...baseInput, symbol: 'UNKNOWNSTOCK' };
      const result = await service.score(input);
      const sectorCheck = result.checks.find((c) => c.name === 'Sector aligned');
      expect(sectorCheck?.passed).toBe(false);
      expect(sectorCheck?.detail?.reason).toBe('no sector mapping');
      const rsCheck = result.checks.find((c) => c.name === 'Relative strength');
      expect(rsCheck?.passed).toBe(false);
      expect(rsCheck?.detail?.reason).toBe('no sector mapping');
    });

    it('broker throws for first check → that check fails but others continue', async () => {
      // First call throws (sector check), rest succeed
      mockAdapter.getHistoricalData
        .mockRejectedValueOnce(new Error('Angel timeout'))
        .mockResolvedValue(rising(60, 100, 0.5));
      const result = await service.score(baseInput);
      expect(result.checks.length).toBe(10);
      const sector = result.checks.find((c) => c.name === 'Sector aligned');
      expect(sector?.detail?.error).toBe('Angel timeout');
    });
  });

  describe('checkRelativeStrength', () => {
    const buyInput: ScoringInput = {
      token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
      entryPrice: 2880, setupContext: null,
    };
    const sellInput: ScoringInput = { ...buyInput, side: 'SELL' };

    function rising(n: number, start: number, step: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: start + i * step, high: start + i * step + 0.5, low: start + i * step - 0.5,
        close: start + i * step + 0.25, volume: 1000 + i * 50,
      }));
    }

    it('BUY: stock outperforming sector → RS check passes', async () => {
      // Stock rises faster (step 1.0) than sector (step 0.2)
      // RELIANCE token = '2885', sector token = '99926019' (NIFTY ENERGY)
      const stockBars = rising(30, 100, 1.0);
      const sectorBars = rising(30, 100, 0.2);
      mockAdapter.getHistoricalData.mockImplementation(
        (token: string) => Promise.resolve(token === '2885' ? stockBars : sectorBars),
      );
      // Call checkRelativeStrength directly via the private path through score()
      // — but we only want to verify the RS check specifically.
      const result = await service.score(buyInput);
      const rs = result.checks.find((c) => c.name === 'Relative strength');
      expect(rs?.passed).toBe(true);
      expect(rs?.points).toBe(10);
      expect((rs?.detail?.rs as number)).toBeGreaterThan(0);
    });

    it('BUY: stock underperforming sector → RS check fails', async () => {
      // Stock rises slower (step 0.1) than sector (step 1.0)
      const stockBars = rising(30, 100, 0.1);
      const sectorBars = rising(30, 100, 1.0);
      mockAdapter.getHistoricalData.mockImplementation(
        (token: string) => Promise.resolve(token === '2885' ? stockBars : sectorBars),
      );
      const result = await service.score(buyInput);
      const rs = result.checks.find((c) => c.name === 'Relative strength');
      expect(rs?.passed).toBe(false);
      expect(rs?.points).toBe(0);
      expect((rs?.detail?.rs as number)).toBeLessThan(0);
    });

    it('SELL: stock underperforming sector → RS check passes', async () => {
      // Stock rises slower than sector — stock is relatively weak → SELL passes
      const stockBars = rising(30, 100, 0.1);
      const sectorBars = rising(30, 100, 1.0);
      mockAdapter.getHistoricalData.mockImplementation(
        (token: string) => Promise.resolve(token === '2885' ? stockBars : sectorBars),
      );
      const result = await service.score(sellInput);
      const rs = result.checks.find((c) => c.name === 'Relative strength');
      expect(rs?.passed).toBe(true);
      expect(rs?.points).toBe(10);
    });

    it('no sector mapping → RS check fails with reason: "no sector mapping"', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(rising(30, 100, 0.5));
      const input: ScoringInput = { ...buyInput, symbol: 'UNKNOWNSTOCK' };
      const result = await service.score(input);
      const rs = result.checks.find((c) => c.name === 'Relative strength');
      expect(rs?.passed).toBe(false);
      expect(rs?.detail?.reason).toBe('no sector mapping');
    });
  });

  describe('classifyTrend (via Price vs 20-EMA check)', () => {
    const buyInput: ScoringInput = {
      token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
      entryPrice: 2880, setupContext: null,
    };
    const sellInput: ScoringInput = { ...buyInput, side: 'SELL' };

    function rising(n: number, start: number, step: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: start + i * step, high: start + i * step + 0.5, low: start + i * step - 0.5,
        close: start + i * step + 0.25, volume: 1000 + i * 50,
      }));
    }
    function falling(n: number, start: number, step: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: start - i * step, high: start - i * step + 0.5, low: start - i * step - 0.5,
        close: start - i * step - 0.25, volume: 1000 + i * 50,
      }));
    }
    function flat(n: number, price: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: price, high: price + 0.1, low: price - 0.1,
        close: price, volume: 1000,
      }));
    }

    it('rising closes → UP → Price vs 20-EMA passes for BUY', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(rising(60, 100, 0.5));
      const result = await service.score(buyInput);
      const check = result.checks.find((c) => c.name === 'Price vs 20-EMA');
      expect(check?.passed).toBe(true);
      expect(check?.detail?.trend).toBe('UP');
    });

    it('falling closes → DOWN → Price vs 20-EMA passes for SELL', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(falling(60, 100, 0.5));
      const result = await service.score(sellInput);
      const check = result.checks.find((c) => c.name === 'Price vs 20-EMA');
      expect(check?.passed).toBe(true);
      expect(check?.detail?.trend).toBe('DOWN');
    });

    it('flat closes (EMA flat, price hovering) → INDETERMINATE → fails for BUY', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(flat(60, 100));
      const result = await service.score(buyInput);
      const check = result.checks.find((c) => c.name === 'Price vs 20-EMA');
      expect(check?.passed).toBe(false);
      expect(check?.detail?.trend).toBe('INDETERMINATE');
    });

    it('flat closes → INDETERMINATE → fails for SELL too', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(flat(60, 100));
      const result = await service.score(sellInput);
      const check = result.checks.find((c) => c.name === 'Price vs 20-EMA');
      expect(check?.passed).toBe(false);
      expect(check?.detail?.trend).toBe('INDETERMINATE');
    });
  });

  // ─── Task 3: MACD warmup ────────────────────────────────────────────────
  describe('MACD warmup (260-bar window converges, 60-bar tail diverges)', () => {
    // A long, realistic-ish price series with mild trend + noise. Built
    // deterministically so the assertions are stable.
    function longSeries(n: number): number[] {
      const out: number[] = [];
      let p = 100;
      for (let i = 0; i < n; i++) {
        // Gentle upward drift + a deterministic sinusoidal wobble.
        p += 0.08 + Math.sin(i / 7) * 0.9 + Math.cos(i / 23) * 0.4;
        out.push(p);
      }
      return out;
    }

    it('MACD on a 60-bar tail DIVERGES from MACD on the full series (EMA not warmed)', () => {
      const full = longSeries(400);
      const fullMacd = macd(full)!;
      const tail60 = full.slice(-60);
      const tail60Macd = macd(tail60)!;
      // The 26-EMA seeded only 34 bars before the read point is far from
      // converged — its residual is several percent of the MACD value.
      const diff = Math.abs(fullMacd.macd - tail60Macd.macd);
      const rel = diff / Math.max(1e-9, Math.abs(fullMacd.macd));
      expect(rel).toBeGreaterThan(0.02); // > 2% divergence
    });

    it('MACD on a 250-bar window MATCHES the full-series MACD within tiny tolerance', () => {
      const full = longSeries(600);
      const fullMacd = macd(full)!;
      const win250 = full.slice(-250);
      const win250Macd = macd(win250)!;
      const diff = Math.abs(fullMacd.macd - win250Macd.macd);
      const rel = diff / Math.max(1e-9, Math.abs(fullMacd.macd));
      // 250 bars warms the 26-EMA so thoroughly the seed residual is
      // (1 - k)^224 ≈ 10^-7 — effectively identical to the full series.
      expect(rel).toBeLessThan(1e-4);
    });
  });

  // ─── Task 3 + 4: MACD checks request 250 bars, condition = green AND zero ─
  describe('checkMacdAtTf — 250-bar request + insufficient floor + zero-line', () => {
    const buyInput: ScoringInput = {
      token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
      entryPrice: 2880, setupContext: null,
    };
    const sellInput: ScoringInput = { ...buyInput, side: 'SELL' };

    // A synthetic candle series whose closes are fully controllable.
    function candlesFromCloses(closes: number[]) {
      return closes.map((c, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i)),
        open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000,
      }));
    }
    // Strong, ACCELERATING uptrend → MACD line green (macd > signal) AND
    // above zero. NOTE: a constant-slope ramp (p += k) is the wrong fixture
    // here — on a straight line the fast and slow EMAs both converge to the
    // same lagged value, so macd === signal exactly (histogram 0), which is
    // neither green nor red. The check's pass condition uses STRICT macd >
    // signal, so a flat-histogram series fails. An accelerating trend keeps
    // the fast EMA genuinely ahead of the slow EMA → histogram stays > 0.
    function strongUp(n: number): number[] {
      const out: number[] = [];
      let p = 100;
      for (let i = 0; i < n; i++) { p += 1.0 + i * 0.03; out.push(p); }
      return out;
    }
    // Strong, ACCELERATING downtrend → MACD red (macd < signal) AND below
    // zero. Same reasoning as strongUp — a constant-slope drop gives a flat
    // (zero) histogram which is not red. Floor at 1 so prices stay positive.
    function strongDown(n: number): number[] {
      const out: number[] = [];
      let p = 4000;
      for (let i = 0; i < n; i++) { p -= 1.0 + i * 0.03; out.push(Math.max(p, 1)); }
      return out;
    }

    it('insufficient floor: 100 bars (< 120) → fails with reason "insufficient candles"', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(strongUp(100)));
      const result = await service.score(buyInput);
      const macdDaily = result.checks.find((c) => c.name === 'MACD on 1d');
      expect(macdDaily?.passed).toBe(false);
      expect(macdDaily?.detail?.reason).toBe('insufficient candles');
    });

    it('BUY passes only when MACD green AND above zero', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(strongUp(300)));
      const result = await service.score(buyInput);
      const macdDaily = result.checks.find((c) => c.name === 'MACD on 1d')!;
      expect(macdDaily.passed).toBe(true);
      expect(macdDaily.detail?.aboveZero).toBe(true);
      expect(macdDaily.points).toBe(10);
    });

    it('BUY fails when MACD green but BELOW zero (recovering downtrend)', async () => {
      // Long downtrend then a short up-tick: macd > signal (green) but the
      // MACD line is still negative. Exactly 250 bars so fetchCandles'
      // tail-slice is a no-op and the check sees this same series.
      const downBars = strongDown(250 - 12);
      const last = downBars[downBars.length - 1];
      const upTail = Array.from({ length: 12 }, (_, i) => last + (i + 1) * 2);
      const closes = [...downBars, ...upTail];
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(closes));
      const result = await service.score(buyInput);
      const macdDaily = result.checks.find((c) => c.name === 'MACD on 1d')!;
      const m = macd(closes)!;
      // Sanity: this fixture really is green-but-below-zero.
      expect(m.macd).toBeGreaterThan(m.signal);
      expect(m.macd).toBeLessThan(0);
      expect(macdDaily.passed).toBe(false);
      expect(macdDaily.detail?.aboveZero).toBe(false);
    });

    it('SELL passes only when MACD red AND below zero', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(strongDown(300)));
      const result = await service.score(sellInput);
      const macdDaily = result.checks.find((c) => c.name === 'MACD on 1d')!;
      expect(macdDaily.passed).toBe(true);
      expect(macdDaily.detail?.belowZero).toBe(true);
      expect(macdDaily.points).toBe(10);
    });

    it('SELL fails when MACD red but ABOVE zero (cooling uptrend)', async () => {
      // Long uptrend then a short down-tick: macd < signal (red) but the
      // MACD line is still positive. Exactly 250 bars.
      const upBars = strongUp(250 - 12);
      const last = upBars[upBars.length - 1];
      const downTail = Array.from({ length: 12 }, (_, i) => last - (i + 1) * 2);
      const closes = [...upBars, ...downTail];
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(closes));
      const result = await service.score(sellInput);
      const macdDaily = result.checks.find((c) => c.name === 'MACD on 1d')!;
      const m = macd(closes)!;
      expect(m.macd).toBeLessThan(m.signal);
      expect(m.macd).toBeGreaterThan(0);
      expect(macdDaily.passed).toBe(false);
      expect(macdDaily.detail?.belowZero).toBe(false);
    });

    it('all three MACD checks request 250 bars worth of history', async () => {
      // fetchCandles sizes the date window from lookbackMsForTf(tf, lookback).
      // With lookback=250, the 1d window must span >= 250*2+30 calendar days.
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(strongUp(300)));
      await service.score(buyInput);
      const dailyCall = mockAdapter.getHistoricalData.mock.calls.find(
        (c: unknown[]) => c[2] === '1d',
      );
      expect(dailyCall).toBeDefined();
      const from = dailyCall![3] as Date;
      const to = dailyCall![4] as Date;
      const spanDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
      // 250*2+30 = 530 calendar days minimum for a 250-bar 1d request.
      expect(spanDays).toBeGreaterThanOrEqual(530);
    });
  });

  // ─── Task 5: dataStarved flag ───────────────────────────────────────────
  describe('dataStarved flag on ScoringResult', () => {
    const buyInput: ScoringInput = {
      token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
      entryPrice: 2880, setupContext: null,
    };

    function risingCandles(n: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: 100 + i * 0.5, high: 100 + i * 0.5 + 0.5, low: 100 + i * 0.5 - 0.5,
        close: 100 + i * 0.5 + 0.25, volume: 1000 + i * 50,
      }));
    }

    it('exposes dataStarved: boolean on every result', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(risingCandles(300));
      const result = await service.score(buyInput);
      expect(typeof result.dataStarved).toBe('boolean');
    });

    it('dataStarved=true when 3+ checks fail due to missing/insufficient candles', async () => {
      // Empty candles everywhere → most checks fail with insufficient-data reasons.
      mockAdapter.getHistoricalData.mockResolvedValue([]);
      const result = await service.score(buyInput);
      expect(result.dataStarved).toBe(true);
    });

    it('dataStarved=true when checks fail because the broker throttled (typed error)', async () => {
      const throttle = new Error('Angel One historical throttled — data:null');
      (throttle as Error & { name: string }).name = 'AngelThrottleError';
      mockAdapter.getHistoricalData.mockRejectedValue(throttle);
      const result = await service.score(buyInput);
      expect(result.dataStarved).toBe(true);
    });

    it('dataStarved=false when checks fail on genuine signal (data present, trend wrong)', async () => {
      // Plenty of candles → no insufficient-data reasons. A falling series on
      // a BUY setup fails many checks, but for SIGNAL reasons, not data.
      mockAdapter.getHistoricalData.mockResolvedValue(
        Array.from({ length: 300 }, (_, i) => ({
          timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
          open: 1000 - i * 0.5, high: 1000 - i * 0.5 + 0.5, low: 1000 - i * 0.5 - 0.5,
          close: 1000 - i * 0.5 - 0.25, volume: 1000 + i * 50,
        })),
      );
      const result = await service.score(buyInput);
      expect(result.dataStarved).toBe(false);
    });
  });

  // ─── As-of-time scoring (backtest replay) ───────────────────────────────
  describe('asOf — historical candle fetches end at a past timestamp', () => {
    const buyInput: ScoringInput = {
      token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
      entryPrice: 2880, setupContext: null,
    };

    function risingCandles(n: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: 100 + i * 0.5, high: 100 + i * 0.5 + 0.5, low: 100 + i * 0.5 - 0.5,
        close: 100 + i * 0.5 + 0.25, volume: 1000 + i * 50,
      }));
    }

    it('passing asOf makes EVERY historical fetch use `to` === that past date', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(risingCandles(300));
      const asOf = new Date(Date.UTC(2026, 3, 1, 9, 30)); // 2026-04-01 09:30 UTC

      await service.score({ ...buyInput, asOf });

      expect(mockAdapter.getHistoricalData).toHaveBeenCalled();
      // Every call's `to` arg (index 4) must equal asOf exactly.
      for (const call of mockAdapter.getHistoricalData.mock.calls) {
        const to = call[4] as Date;
        expect(to.getTime()).toBe(asOf.getTime());
      }
    });

    it('asOf also shifts the `from` arg back from asOf (window ends at asOf, not now)', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(risingCandles(300));
      const asOf = new Date(Date.UTC(2026, 3, 1, 9, 30));

      await service.score({ ...buyInput, asOf });

      for (const call of mockAdapter.getHistoricalData.mock.calls) {
        const from = call[3] as Date;
        const to = call[4] as Date;
        // from is strictly before to, and the window ends exactly at asOf.
        expect(from.getTime()).toBeLessThan(to.getTime());
        expect(to.getTime()).toBe(asOf.getTime());
      }
    });

    it('omitting asOf → every fetch `to` is approximately now (unchanged behaviour)', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(risingCandles(300));
      const before = Date.now();

      await service.score(buyInput);

      const after = Date.now();
      expect(mockAdapter.getHistoricalData).toHaveBeenCalled();
      for (const call of mockAdapter.getHistoricalData.mock.calls) {
        const to = call[4] as Date;
        // `to` was new Date() at fetch time — within the test's wall-clock window.
        expect(to.getTime()).toBeGreaterThanOrEqual(before);
        expect(to.getTime()).toBeLessThanOrEqual(after + 1000);
      }
    });
  });
});
