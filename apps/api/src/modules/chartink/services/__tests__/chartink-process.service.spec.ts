import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ChartinkProcessService } from '../chartink-process.service';
import { ChartinkRepository } from '../../repositories/chartink.repository';
import { MarketDataRepository } from '../../../market-data/repositories/market-data.repository';
import { MtfAlignmentService } from '../../../signal-generator/services/mtf-alignment.service';
import { ChartinkScoringService } from '../chartink-scoring.service';
import { AngelOneAdapterService } from '../../../market-data/services/angel-one-adapter.service';
import { NseSectorIndexService } from '../../../market-data/services/nse-sector-index.service';
import { WatchService, WatchCapExceededError } from '../../../watch-monitor/services/watch.service';
import * as marketHours from '../../../../common/utils/market-hours';

/** A 5-min-MACD score-check entry, for exercising the MACD entry gate. */
const macd5mCheck = (passed: boolean) => ({
  name: 'MACD on 5m', points: passed ? 8 : 0, pointsPossible: 8, passed,
});

/** A SuperTrend match score-check entry, for exercising the SuperTrend entry gate. */
const supertrendCheck = (passed: boolean) => ({
  name: 'SuperTrend match', points: passed ? 8 : 0, pointsPossible: 8, passed,
});

/** Generate a minimal 50-bar closes array trending UP (each bar slightly higher). */
function makeTrendingCloses(direction: 'UP' | 'DOWN' | 'FLAT', n = 50): number[] {
  const closes: number[] = [];
  const step = direction === 'UP' ? 1 : direction === 'DOWN' ? -1 : 0;
  for (let i = 0; i < n; i++) closes.push(100 + i * step);
  return closes;
}

describe('ChartinkProcessService', () => {
  let service: ChartinkProcessService;
  let repo: { createAlertSetup: jest.Mock };
  let mdRepo: { getInstrumentBySymbol: jest.Mock; getInstrumentByToken: jest.Mock };
  let mtf: { check: jest.Mock };
  let scoring: { score: jest.Mock; scoreToLotCount: jest.Mock };
  let angelOne: { getHistoricalData: jest.Mock };
  let nseSector: { getSectorIndexForSymbol: jest.Mock };
  let watchSvc: { createFromAlert: jest.Mock };

  // Default happy-path candles — 50 bars trending UP, enough for classifyTrend
  const UP_CANDLES = makeTrendingCloses('UP', 50).map((close) => ({ close, timestamp: new Date(), open: close, high: close, low: close, volume: 1000 }));

  beforeEach(async () => {
    // R3: freeze the clock to 10:00 IST - outside the 11:45-14:00 strict
    // window - so the default score-70 mock is admitted deterministically.
    jest.useFakeTimers({ now: new Date('2026-05-19T04:30:00Z') });
    // Default: every test runs as if INSIDE the 09:15-15:00 IST entry window
    // so the pipeline is exercised. The dedicated cutoff describe-block below
    // overrides this with its own spy to test the closed-market path.
    jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(true);
    repo = { createAlertSetup: jest.fn().mockResolvedValue({ id: 'setup-row-1' }) };
    mdRepo = {
      getInstrumentBySymbol: jest.fn(),
      getInstrumentByToken: jest.fn(),
    };
    mtf = {
      check: jest.fn().mockResolvedValue({
        aligned: true,
        agreedDirection: 'UP',
        directions: { '1d': 'UP', '1h': 'UP', '15m': 'UP', '5m': 'UP' },
        summary: '1d=UP 1h=UP 15m=UP 5m=UP',
      }),
    };
    scoring = {
      score: jest.fn().mockResolvedValue({ score: 70, lotCount: 2, checks: [macd5mCheck(true), supertrendCheck(true)] }),
      scoreToLotCount: jest.fn(),
    };
    // Default: 50 UP-trending candles so classifyTrend returns 'UP'
    angelOne = { getHistoricalData: jest.fn().mockResolvedValue(UP_CANDLES) };
    nseSector = { getSectorIndexForSymbol: jest.fn().mockResolvedValue('99926019') };
    watchSvc = { createFromAlert: jest.fn().mockResolvedValue({ id: 'w1' }) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChartinkProcessService,
        { provide: ChartinkRepository, useValue: repo },
        { provide: MarketDataRepository, useValue: mdRepo },
        { provide: MtfAlignmentService, useValue: mtf },
        { provide: ChartinkScoringService, useValue: scoring },
        { provide: AngelOneAdapterService, useValue: angelOne },
        { provide: NseSectorIndexService, useValue: nseSector },
        { provide: WatchService, useValue: watchSvc },
      ],
    }).compile();

    service = moduleRef.get(ChartinkProcessService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  // ─── Step 1: Symbol resolution ─────────────────────────────────────────────

  it('persists kind=unresolved when symbol not in DB', async () => {
    mdRepo.getInstrumentBySymbol.mockResolvedValue(null);

    await service.processOne('alert-1', { symbol: 'UNKNOWN', hitPrice: 100 });

    expect(repo.createAlertSetup).toHaveBeenCalledWith({
      alertId: 'alert-1',
      symbol: 'UNKNOWN',
      token: null,
      hitPrice: 100,
      kind: 'unresolved',
      setupId: null,
      rejectReason: 'symbol not in local DB (tried bare, -EQ, -BE, -BL, -IV)',
    });
  });

  it('does NOT proceed to scoring when symbol fails to resolve', async () => {
    mdRepo.getInstrumentBySymbol.mockResolvedValue(null);
    await service.processOne('alert-1', { symbol: 'UNKNOWN', hitPrice: 100 });
    expect(scoring.score).not.toHaveBeenCalled();
    expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unresolved' }));
  });

  // ─── Step 2: MTF no longer gates ───────────────────────────────────────────
  // The pure score-based pipeline removed the MTF alignment pre-screen. MTF
  // misalignment must NOT cause an early reject — the stock proceeds straight
  // to direction-resolution and scoring. The mtf-misaligned kind is never
  // produced anywhere anymore.

  describe('MTF no longer gates the pipeline', () => {
    it('proceeds to scoring (and becomes a setup) even when MTF would be misaligned', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      // Even if an MTF check were run, it would say "misaligned" — must not matter.
      mtf.check.mockResolvedValue({
        aligned: false,
        agreedDirection: null,
        directions: { '1d': 'UP', '1h': 'UP', '15m': 'DOWN', '5m': 'UP' },
        summary: '1d=UP 1h=UP 15m=DOWN 5m=UP',
      });
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [macd5mCheck(true), supertrendCheck(true)] });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      // Pipeline reached scoring and produced a setup — no early MTF reject.
      expect(scoring.score).toHaveBeenCalled();
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
    });

    it('never produces kind=mtf-misaligned', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      mtf.check.mockResolvedValue({
        aligned: false,
        agreedDirection: null,
        directions: { '1d': 'UP', '1h': 'UP', '15m': 'DOWN', '5m': 'UP' },
        summary: '1d=UP 1h=UP 15m=DOWN 5m=UP',
      });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      const kinds = repo.createAlertSetup.mock.calls.map((c) => c[0].kind);
      expect(kinds).not.toContain('mtf-misaligned');
    });
  });

  // ─── Step 3: Direction gate (sector with stock-trend fallback) ────────────

  describe('Direction gate (sector with stock-trend fallback)', () => {
    beforeEach(() => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE', symbol: 'NIFTY ENERGY' });
    });

    // Helper: build flat candles that make classifyTrend return INDETERMINATE.
    const flatCandles = Array.from({ length: 50 }, () => ({
      close: 100, timestamp: new Date(), open: 100, high: 100, low: 100, volume: 1,
    }));
    // Helper: build short candles (under 26 bars) — insufficient for classifyTrend.
    const shortCandles = Array.from({ length: 10 }, (_, i) => ({
      close: 100 + i, timestamp: new Date(), open: 100 + i, high: 100 + i, low: 100 + i, volume: 1,
    }));

    it('falls back to stock trend (UP→BUY) when no sector mapping exists', async () => {
      nseSector.getSectorIndexForSymbol.mockResolvedValue(null);
      // Default UP_CANDLES → stock trend UP → side=BUY → scoring → setup
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 100 });

      expect(scoring.score).toHaveBeenCalledWith(expect.objectContaining({ side: 'BUY' }));
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
    });

    it('falls back to stock trend when sector index token not in DB', async () => {
      nseSector.getSectorIndexForSymbol.mockResolvedValue('99926019');
      mdRepo.getInstrumentByToken.mockResolvedValue(null);
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 100 });

      expect(scoring.score).toHaveBeenCalledWith(expect.objectContaining({ side: 'BUY' }));
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
    });

    it('falls back to stock trend when sector candles insufficient', async () => {
      // Sector returns short candles. Stock fetch (second call) returns UP_CANDLES.
      angelOne.getHistoricalData
        .mockResolvedValueOnce(shortCandles)  // sector
        .mockResolvedValueOnce(UP_CANDLES);    // stock fallback
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 100 });

      expect(scoring.score).toHaveBeenCalledWith(expect.objectContaining({ side: 'BUY' }));
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
    });

    it('falls back to stock trend when sector trend is INDETERMINATE', async () => {
      const downCandles = makeTrendingCloses('DOWN', 50).map((close) => ({
        close, timestamp: new Date(), open: close, high: close, low: close, volume: 1,
      }));
      angelOne.getHistoricalData
        .mockResolvedValueOnce(flatCandles)   // sector → INDETERMINATE
        .mockResolvedValueOnce(downCandles);  // stock fallback → DOWN → side SELL
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 100 });

      expect(scoring.score).toHaveBeenCalledWith(expect.objectContaining({ side: 'SELL' }));
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
    });

    it('persists no-direction when sector AND stock trend both unclear', async () => {
      // Both calls return flat candles → both INDETERMINATE.
      angelOne.getHistoricalData.mockResolvedValue(flatCandles);
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 100 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'no-direction',
        rejectReason: expect.stringContaining('stock trend also unclear'),
      }));
      expect(scoring.score).not.toHaveBeenCalled();
    });

    it('persists no-direction when sector fetch fails AND stock candles insufficient', async () => {
      angelOne.getHistoricalData
        .mockRejectedValueOnce(new Error('broker timeout'))  // sector
        .mockResolvedValueOnce(shortCandles);                 // stock fallback also insufficient
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 100 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'no-direction',
        rejectReason: expect.stringContaining('sector candle fetch failed: broker timeout'),
      }));
      expect(scoring.score).not.toHaveBeenCalled();
    });

    it('derives side=BUY when sector trend is UP (happy path)', async () => {
      // Default UP_CANDLES on sector fetch → side=BUY directly, no stock fallback.
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });
      expect(scoring.score).toHaveBeenCalledWith(expect.objectContaining({ side: 'BUY' }));
    });

    it('derives side=SELL when sector trend is DOWN', async () => {
      const downCandles = makeTrendingCloses('DOWN', 50).map((close) => ({
        close, timestamp: new Date(), open: close, high: close, low: close, volume: 1,
      }));
      angelOne.getHistoricalData.mockResolvedValue(downCandles);
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });
      expect(scoring.score).toHaveBeenCalledWith(expect.objectContaining({ side: 'SELL' }));
    });
  });

  // ─── Steps 4+5: Scoring + persistence ─────────────────────────────────────

  describe('Scoring and persistence', () => {
    beforeEach(() => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE', symbol: 'NIFTY ENERGY' });
      // UP candles → sector trend UP → side BUY
      angelOne.getHistoricalData.mockResolvedValue(UP_CANDLES);
    });

    it('persists kind=setup and calls watch.createFromAlert when score >= 60', async () => {
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [{ name: 'Sector aligned', points: 10, pointsPossible: 10, passed: true }, macd5mCheck(true), supertrendCheck(true)] });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        alertId: 'alert-1',
        symbol: 'RELIANCE',
        token: '2885',
        hitPrice: 2885,
        kind: 'setup',
        setupId: null,
        rejectReason: null,
        score: 70,
        lotCount: 2,
        scoreBreakdown: expect.any(Array),
      }));
      expect(watchSvc.createFromAlert).toHaveBeenCalledWith(expect.objectContaining({
        alertId: 'alert-1',
        setupId: 'setup-row-1',
        symbol: 'RELIANCE',
        token: '2885',
        exchange: 'NSE',
        side: 'BUY',
        initialPrice: 2885,
        initialScore: 70,
      }));
    });

    it('persists kind=scored-low and does NOT call watch.createFromAlert when score < 60', async () => {
      scoring.score.mockResolvedValue({ score: 40, lotCount: 0, checks: [] });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'scored-low',
        rejectReason: 'score 40 below 60',
        score: 40,
        lotCount: 0,
      }));
      expect(watchSvc.createFromAlert).not.toHaveBeenCalled();
    });

    it('persists kind=scored-low for a score of 55 (above old 50 floor, below new 60 floor)', async () => {
      scoring.score.mockResolvedValue({ score: 55, lotCount: 0, checks: [macd5mCheck(true), supertrendCheck(true)] });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'scored-low',
        rejectReason: 'score 55 below 60',
      }));
      expect(watchSvc.createFromAlert).not.toHaveBeenCalled();
    });

    it('persists kind=error when scoring.score throws', async () => {
      scoring.score.mockRejectedValue(new Error('indicator crash'));

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'error',
        rejectReason: 'indicator crash',
      }));
      expect(watchSvc.createFromAlert).not.toHaveBeenCalled();
    });

    it('still persists kind=setup even when watch.createFromAlert throws WatchCapExceededError', async () => {
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [macd5mCheck(true), supertrendCheck(true)] });
      watchSvc.createFromAlert.mockRejectedValue(new WatchCapExceededError(50));

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      // setup must be persisted before the watch call
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
      // No second createAlertSetup call (watch error must not re-persist)
      expect(repo.createAlertSetup).toHaveBeenCalledTimes(1);
    });

    it('still persists kind=setup even when watch.createFromAlert throws unexpected error', async () => {
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [macd5mCheck(true), supertrendCheck(true)] });
      watchSvc.createFromAlert.mockRejectedValue(new Error('db connection lost'));

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
      expect(repo.createAlertSetup).toHaveBeenCalledTimes(1);
    });

    it('scores with correct token, symbol, exchange, entryPrice from hit', async () => {
      scoring.score.mockResolvedValue({ score: 60, lotCount: 1, checks: [] });

      await service.processOne('alert-99', { symbol: 'TCS', hitPrice: 3500 });

      expect(scoring.score).toHaveBeenCalledWith({
        token: '2885',
        symbol: 'TCS',
        exchange: 'NSE',
        side: 'BUY',
        entryPrice: 3500,
        setupContext: null,
      });
    });

    // ─── Pure score-based: MACD-5m and SuperTrend no longer veto ────────────
    // These two checks remain SCORED factors inside ChartinkScoringService —
    // they contribute points — but a failing/absent check no longer kills an
    // entry. As long as the total score reaches 60 the stock becomes a setup.

    it('becomes a setup when the 5m MACD check FAILS but score is still >= 60', async () => {
      scoring.score.mockResolvedValue({
        score: 80, lotCount: 3, checks: [macd5mCheck(false), supertrendCheck(true)],
      });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'setup',
        score: 80,
      }));
      expect(watchSvc.createFromAlert).toHaveBeenCalled();
    });

    it('becomes a setup when the SuperTrend check FAILS but score is still >= 60', async () => {
      scoring.score.mockResolvedValue({
        score: 80, lotCount: 3, checks: [macd5mCheck(true), supertrendCheck(false)],
      });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'setup',
        score: 80,
        lotCount: 3,
      }));
      expect(watchSvc.createFromAlert).toHaveBeenCalled();
    });

    it('becomes a setup when the SuperTrend check is missing entirely but score is >= 60', async () => {
      scoring.score.mockResolvedValue({
        score: 75, lotCount: 2, checks: [macd5mCheck(true)],
      });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'setup',
        score: 75,
      }));
      expect(watchSvc.createFromAlert).toHaveBeenCalled();
    });

    it('becomes a setup when BOTH the 5m MACD and SuperTrend checks fail but score is >= 60', async () => {
      scoring.score.mockResolvedValue({
        score: 65, lotCount: 1, checks: [macd5mCheck(false), supertrendCheck(false)],
      });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
      expect(watchSvc.createFromAlert).toHaveBeenCalled();
    });

    it('still rejects as scored-low when the 5m MACD passes but the total score is < 60', async () => {
      scoring.score.mockResolvedValue({
        score: 45, lotCount: 0, checks: [macd5mCheck(true), supertrendCheck(true)],
      });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'scored-low',
        rejectReason: 'score 45 below 60',
      }));
      expect(watchSvc.createFromAlert).not.toHaveBeenCalled();
    });

    it('never produces kind=macd-misaligned or kind=supertrend-misaligned', async () => {
      scoring.score.mockResolvedValue({
        score: 80, lotCount: 3, checks: [macd5mCheck(false), supertrendCheck(false)],
      });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      const kinds = repo.createAlertSetup.mock.calls.map((c) => c[0].kind);
      expect(kinds).not.toContain('macd-misaligned');
      expect(kinds).not.toContain('supertrend-misaligned');
    });

    it('rejects a score-70 setup inside the 11:45-14:00 IST window (R3 needs >=75)', async () => {
      jest.setSystemTime(new Date('2026-05-19T06:30:00Z')); // 12:00 IST
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [] });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(watchSvc.createFromAlert).not.toHaveBeenCalled();
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'scored-low',
        rejectReason: expect.stringContaining('11:45-14:00'),
      }));
    });

    it('still admits a score-80 setup inside the 11:45-14:00 IST window', async () => {
      jest.setSystemTime(new Date('2026-05-19T06:30:00Z')); // 12:00 IST
      scoring.score.mockResolvedValue({ score: 80, lotCount: 3, checks: [] });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
      expect(watchSvc.createFromAlert).toHaveBeenCalled();
    });
  });

  // ─── Stage 2 integration: watch.createFromAlert wiring ────────────────────

  describe('Stage 2 wiring (watch monitor)', () => {
    beforeEach(() => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      angelOne.getHistoricalData.mockResolvedValue(UP_CANDLES);
    });

    it('calls createFromAlert with setupId returned by repo.createAlertSetup', async () => {
      repo.createAlertSetup.mockResolvedValue({ id: 'my-setup-id-42' });
      scoring.score.mockResolvedValue({ score: 75, lotCount: 2, checks: [macd5mCheck(true), supertrendCheck(true)] });

      await service.processOne('alert-A', { symbol: 'INFY', hitPrice: 1800 });

      expect(watchSvc.createFromAlert).toHaveBeenCalledWith(expect.objectContaining({
        setupId: 'my-setup-id-42',
      }));
    });

    it('does NOT call createFromAlert when score is exactly 59', async () => {
      scoring.score.mockResolvedValue({ score: 59, lotCount: 0, checks: [macd5mCheck(true), supertrendCheck(true)] });

      await service.processOne('alert-A', { symbol: 'INFY', hitPrice: 1800 });

      expect(watchSvc.createFromAlert).not.toHaveBeenCalled();
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'scored-low',
      }));
    });

    it('calls createFromAlert when score is exactly 60', async () => {
      scoring.score.mockResolvedValue({ score: 60, lotCount: 1, checks: [macd5mCheck(true), supertrendCheck(true)] });

      await service.processOne('alert-A', { symbol: 'INFY', hitPrice: 1800 });

      expect(watchSvc.createFromAlert).toHaveBeenCalled();
    });
  });

  // ─── 15:00 IST entry cutoff (ingest gate) ─────────────────────────────────
  // No new WATCHING entry may be created after 15:00 IST. When outside the
  // entry window the stock is rejected with kind='market-closed' BEFORE any
  // scoring or broker work — no symbol resolution, no scoring, no watch entry.

  describe('15:00 IST entry cutoff', () => {
    let windowSpy: jest.SpyInstance;

    afterEach(() => {
      windowSpy?.mockRestore();
    });

    it('rejects with kind=market-closed and skips scoring when outside the entry window', async () => {
      windowSpy = jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(false);
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        alertId: 'alert-1',
        symbol: 'RELIANCE',
        kind: 'market-closed',
        rejectReason: expect.stringContaining('entry window 09:15-15:00 IST'),
      }));
      // No scoring, no watch entry, no symbol resolution work after the gate.
      expect(scoring.score).not.toHaveBeenCalled();
      expect(watchSvc.createFromAlert).not.toHaveBeenCalled();
    });

    it('logs an ingest-stage [trade-rejected] line when outside the entry window', async () => {
      windowSpy = jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(false);
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 }, 'MY SCANNER');

      const line = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((s) => s.startsWith('[trade-rejected]'));
      expect(line).toBeDefined();
      expect(line).toContain('RELIANCE');
      expect(line).toContain('stage=ingest');
      logSpy.mockRestore();
    });

    it('proceeds normally (scores + creates setup) when inside the entry window', async () => {
      windowSpy = jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(true);
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      angelOne.getHistoricalData.mockResolvedValue(UP_CANDLES);
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [macd5mCheck(true), supertrendCheck(true)] });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(scoring.score).toHaveBeenCalled();
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
    });
  });

  // ─── "Why was this not traded" rejection logging ──────────────────────────

  describe('rejection logging', () => {
    let logSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('logs a [trade-rejected] line for unresolved symbols (process stage)', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue(null);

      await service.processOne('alert-1', { symbol: 'UNKNOWN', hitPrice: 100 }, 'MY SCANNER');

      expect(logSpy).toHaveBeenCalledWith(
        '[trade-rejected] UNKNOWN | scan="MY SCANNER" hit=100 | stage=process reason="symbol not in local DB (tried bare, -EQ, -BE, -BL, -IV)"',
      );
    });

    it('logs a [trade-rejected] line for no-direction (process stage)', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      // Both sector and stock trend INDETERMINATE → no-direction.
      const flatCandles = Array.from({ length: 50 }, () => ({
        close: 100, timestamp: new Date(), open: 100, high: 100, low: 100, volume: 1,
      }));
      angelOne.getHistoricalData.mockResolvedValue(flatCandles);

      await service.processOne('alert-1', { symbol: 'GESHIP', hitPrice: 1664 }, 'ANAND HIGH GAINER');

      const noDirCall = logSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('[trade-rejected] GESHIP') && c[0].includes('stage=process'),
      );
      expect(noDirCall).toBeDefined();
    });

    it('logs a [trade-rejected] line for scored-low with side and score (scoring stage)', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      angelOne.getHistoricalData.mockResolvedValue(UP_CANDLES);
      scoring.score.mockResolvedValue({ score: 40, lotCount: 0, checks: [] });

      await service.processOne('alert-1', { symbol: 'RAYMOND', hitPrice: 496.6 }, 'ANAND HIGH GAINER');

      expect(logSpy).toHaveBeenCalledWith(
        '[trade-rejected] RAYMOND | scan="ANAND HIGH GAINER" hit=496.6 side=BUY score=40 | stage=scoring reason="score 40 below 60"',
      );
    });

    it('uses logger.warn (not log) for the error kind', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      angelOne.getHistoricalData.mockResolvedValue(UP_CANDLES);
      scoring.score.mockRejectedValue(new Error('indicator crash'));

      await service.processOne('alert-1', { symbol: 'TCS', hitPrice: 3500 }, 'ANAND HIGH GAINER');

      expect(warnSpy).toHaveBeenCalledWith(
        '[trade-rejected] TCS | scan="ANAND HIGH GAINER" hit=3500 side=BUY | stage=scoring reason="indicator crash"',
      );
    });

    it('omits the scan ctx field when no scan name is supplied', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue(null);

      await service.processOne('alert-1', { symbol: 'UNKNOWN', hitPrice: 100 });

      expect(logSpy).toHaveBeenCalledWith(
        '[trade-rejected] UNKNOWN | hit=100 | stage=process reason="symbol not in local DB (tried bare, -EQ, -BE, -BL, -IV)"',
      );
    });

    it('captures the stock-trend fallback failure text into the no-direction log line', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      // sector fetch fails, stock fallback fetch also throws — must not be swallowed silently
      angelOne.getHistoricalData
        .mockRejectedValueOnce(new Error('sector down'))
        .mockRejectedValueOnce(new Error('stock fetch boom'));

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 100 }, 'ANAND HIGH GAINER');

      const noDirCall = logSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('[trade-rejected]') && c[0].includes('stage=process'),
      );
      expect(noDirCall).toBeDefined();
      expect(noDirCall![0]).toContain('stock fetch boom');
    });
  });
});
