import { Test } from '@nestjs/testing';
import { ChartinkProcessService } from '../chartink-process.service';
import { ChartinkRepository } from '../../repositories/chartink.repository';
import { MarketDataRepository } from '../../../market-data/repositories/market-data.repository';
import { SignalGeneratorService } from '../../../signal-generator/services/signal-generator.service';
import { SetupTrackerService } from '../../../signal-generator/services/setup-tracker.service';
import { MtfAlignmentService } from '../../../signal-generator/services/mtf-alignment.service';
import { ChartinkScoringService } from '../chartink-scoring.service';
import { WatchService } from '../../../watch-monitor/services/watch.service';

describe('ChartinkProcessService', () => {
  let service: ChartinkProcessService;
  let repo: { createAlertSetup: jest.Mock };
  let mdRepo: { getInstrumentBySymbol: jest.Mock };
  let signalSvc: { analyze: jest.Mock };
  let tracker: { getActive: jest.Mock };
  let mtf: { check: jest.Mock };
  let scoring: { score: jest.Mock; scoreToLotCount: jest.Mock };
  let watchSvc: { createFromAlert: jest.Mock };

  beforeEach(async () => {
    repo = { createAlertSetup: jest.fn().mockResolvedValue({ id: 'setup-row-1' }) };
    mdRepo = { getInstrumentBySymbol: jest.fn() };
    signalSvc = { analyze: jest.fn() };
    tracker = { getActive: jest.fn() };
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
    watchSvc = { createFromAlert: jest.fn().mockResolvedValue({ id: 'w1' }) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChartinkProcessService,
        { provide: ChartinkRepository, useValue: repo },
        { provide: MarketDataRepository, useValue: mdRepo },
        { provide: SignalGeneratorService, useValue: signalSvc },
        { provide: SetupTrackerService, useValue: tracker },
        { provide: MtfAlignmentService, useValue: mtf },
        { provide: ChartinkScoringService, useValue: scoring },
        { provide: WatchService, useValue: watchSvc },
      ],
    }).compile();

    service = moduleRef.get(ChartinkProcessService);
  });

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
    expect(signalSvc.analyze).not.toHaveBeenCalled();
  });

  it('persists kind=setup when analyze returns a setup', async () => {
    mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'i1', token: '2885' });
    signalSvc.analyze.mockResolvedValue({ kind: 'setup', symbol: 'RELIANCE' });
    tracker.getActive.mockReturnValue({ id: 'setup-xyz', entry: 1470, stoploss: 1460 });

    await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 1467.4 });

    expect(signalSvc.analyze).toHaveBeenCalledWith('2885', 'NSE', 'RELIANCE', '15m');
    expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
      alertId: 'alert-1',
      symbol: 'RELIANCE',
      token: '2885',
      hitPrice: 1467.4,
      kind: 'setup',
      setupId: 'setup-xyz',
      rejectReason: null,
    }));
  });

  it('persists kind=no-setup when analyze rejects', async () => {
    mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'i1', token: '2885' });
    signalSvc.analyze.mockResolvedValue({ kind: 'no-setup', reason: 'reject:rr {"rr":1.2}' });

    await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 1467.4 });

    expect(repo.createAlertSetup).toHaveBeenCalledWith({
      alertId: 'alert-1',
      symbol: 'RELIANCE',
      token: '2885',
      hitPrice: 1467.4,
      kind: 'no-setup',
      setupId: null,
      rejectReason: 'reject:rr {"rr":1.2}',
    });
  });

  it('persists kind=error when analyze throws', async () => {
    mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'i1', token: '2885' });
    signalSvc.analyze.mockRejectedValue(new Error('broker timeout'));

    await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 1467.4 });

    expect(repo.createAlertSetup).toHaveBeenCalledWith({
      alertId: 'alert-1',
      symbol: 'RELIANCE',
      token: '2885',
      hitPrice: 1467.4,
      kind: 'error',
      setupId: null,
      rejectReason: 'broker timeout',
    });
  });

  describe('MTF gate', () => {
    it('persists mtf-misaligned and SKIPS analyze when TFs disagree', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', symbol: 'RELIANCE' });
      mtf.check.mockResolvedValue({
        aligned: false,
        agreedDirection: null,
        directions: { '1d': 'UP', '1h': 'UP', '15m': 'DOWN', '5m': 'UP' },
        summary: '1d=UP 1h=UP 15m=DOWN 5m=UP',
      });
      signalSvc.analyze.mockResolvedValue({ kind: 'setup' });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(signalSvc.analyze).not.toHaveBeenCalled();
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        alertId: 'alert-1',
        symbol: 'RELIANCE',
        token: '2885',
        hitPrice: 2885,
        kind: 'mtf-misaligned',
        rejectReason: expect.stringContaining('1d=UP 1h=UP 15m=DOWN 5m=UP'),
      }));
    });

    it('proceeds to analyze when MTF reports aligned UP', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', symbol: 'RELIANCE' });
      mtf.check.mockResolvedValue({
        aligned: true,
        agreedDirection: 'UP',
        directions: { '1d': 'UP', '1h': 'UP', '15m': 'UP', '5m': 'UP' },
        summary: '1d=UP 1h=UP 15m=UP 5m=UP',
      });
      signalSvc.analyze.mockResolvedValue({ kind: 'no-setup', reason: 'reject:outside-window' });
      tracker.getActive.mockReturnValue(null);

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(signalSvc.analyze).toHaveBeenCalledTimes(1);
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'no-setup',
      }));
    });

    it('proceeds to analyze when MTF reports aligned DOWN', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', symbol: 'RELIANCE' });
      mtf.check.mockResolvedValue({
        aligned: true,
        agreedDirection: 'DOWN',
        directions: { '1d': 'DOWN', '1h': 'DOWN', '15m': 'DOWN', '5m': 'DOWN' },
        summary: '1d=DOWN 1h=DOWN 15m=DOWN 5m=DOWN',
      });
      signalSvc.analyze.mockResolvedValue({ kind: 'setup' });
      tracker.getActive.mockReturnValue({ id: 'setup-99' });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(signalSvc.analyze).toHaveBeenCalledTimes(1);
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'setup',
        setupId: 'setup-99',
      }));
    });

    it('does NOT call MTF when symbol fails to resolve', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue(null);

      await service.processOne('alert-1', { symbol: 'UNKNOWN', hitPrice: 100 });

      expect(mtf.check).not.toHaveBeenCalled();
      expect(signalSvc.analyze).not.toHaveBeenCalled();
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'unresolved',
      }));
    });
  });

  it('persists score and lotCount when analyze returns a setup', async () => {
    mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', symbol: 'RELIANCE' });
    mtf.check.mockResolvedValue({
      aligned: true,
      agreedDirection: 'UP',
      directions: { '1d': 'UP', '1h': 'UP', '15m': 'UP', '5m': 'UP' },
      summary: '1d=UP 1h=UP 15m=UP 5m=UP',
    });
    signalSvc.analyze.mockResolvedValue({ kind: 'setup' });
    tracker.getActive.mockReturnValue({
      id: 'setup-1',
      entry: 2890,
      stoploss: 2850,
      levelBookSnapshot: { pdh: 2920, pdl: 2850, orh: 2900, orl: 2860, vwap: 2880 },
    });
    scoring.score.mockResolvedValue({
      score: 73,
      lotCount: 2,
      checks: [{ name: 'Sector aligned', points: 20, pointsPossible: 20, passed: true }],
    });

    await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

    expect(scoring.score).toHaveBeenCalledWith(expect.objectContaining({
      token: '2885',
      symbol: 'RELIANCE',
      exchange: 'NSE',
      side: 'BUY',
      entryPrice: 2890,
    }));
    expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'setup',
      score: 73,
      lotCount: 2,
      scoreBreakdown: expect.any(Array),
    }));
  });
});
