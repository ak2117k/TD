import { Test } from '@nestjs/testing';
import { ChartinkProcessService } from '../chartink-process.service';
import { ChartinkRepository } from '../../repositories/chartink.repository';
import { MarketDataRepository } from '../../../market-data/repositories/market-data.repository';
import { MtfAlignmentService } from '../../../signal-generator/services/mtf-alignment.service';
import { ChartinkScoringService } from '../chartink-scoring.service';
import { AngelOneAdapterService } from '../../../market-data/services/angel-one-adapter.service';
import { NseSectorIndexService } from '../../../market-data/services/nse-sector-index.service';
import { WatchService, WatchCapExceededError } from '../../../watch-monitor/services/watch.service';

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
      score: jest.fn().mockResolvedValue({ score: 70, lotCount: 2, checks: [] }),
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
    expect(mtf.check).not.toHaveBeenCalled();
  });

  it('does NOT call MTF when symbol fails to resolve', async () => {
    mdRepo.getInstrumentBySymbol.mockResolvedValue(null);
    await service.processOne('alert-1', { symbol: 'UNKNOWN', hitPrice: 100 });
    expect(mtf.check).not.toHaveBeenCalled();
    expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unresolved' }));
  });

  // ─── Step 2: MTF gate ──────────────────────────────────────────────────────

  describe('MTF gate', () => {
    it('persists mtf-misaligned and stops when TFs disagree', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mtf.check.mockResolvedValue({
        aligned: false,
        agreedDirection: null,
        directions: { '1d': 'UP', '1h': 'UP', '15m': 'DOWN', '5m': 'UP' },
        summary: '1d=UP 1h=UP 15m=DOWN 5m=UP',
      });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        alertId: 'alert-1',
        symbol: 'RELIANCE',
        token: '2885',
        hitPrice: 2885,
        kind: 'mtf-misaligned',
        rejectReason: expect.stringContaining('1d=UP 1h=UP 15m=DOWN 5m=UP'),
      }));
      // Must not proceed to sector gate
      expect(nseSector.getSectorIndexForSymbol).not.toHaveBeenCalled();
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

    it('persists kind=setup and calls watch.createFromAlert when score >= 50', async () => {
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [{ name: 'Sector aligned', points: 10, pointsPossible: 10, passed: true }] });

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

    it('persists kind=scored-low and does NOT call watch.createFromAlert when score < 50', async () => {
      scoring.score.mockResolvedValue({ score: 40, lotCount: 0, checks: [] });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'scored-low',
        rejectReason: 'score 40 below 50',
        score: 40,
        lotCount: 0,
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
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [] });
      watchSvc.createFromAlert.mockRejectedValue(new WatchCapExceededError(50));

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      // setup must be persisted before the watch call
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
      // No second createAlertSetup call (watch error must not re-persist)
      expect(repo.createAlertSetup).toHaveBeenCalledTimes(1);
    });

    it('still persists kind=setup even when watch.createFromAlert throws unexpected error', async () => {
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [] });
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
      scoring.score.mockResolvedValue({ score: 75, lotCount: 2, checks: [] });

      await service.processOne('alert-A', { symbol: 'INFY', hitPrice: 1800 });

      expect(watchSvc.createFromAlert).toHaveBeenCalledWith(expect.objectContaining({
        setupId: 'my-setup-id-42',
      }));
    });

    it('does NOT call createFromAlert when score is exactly 49', async () => {
      scoring.score.mockResolvedValue({ score: 49, lotCount: 0, checks: [] });

      await service.processOne('alert-A', { symbol: 'INFY', hitPrice: 1800 });

      expect(watchSvc.createFromAlert).not.toHaveBeenCalled();
    });

    it('calls createFromAlert when score is exactly 50', async () => {
      scoring.score.mockResolvedValue({ score: 50, lotCount: 1, checks: [] });

      await service.processOne('alert-A', { symbol: 'INFY', hitPrice: 1800 });

      expect(watchSvc.createFromAlert).toHaveBeenCalled();
    });
  });
});
