import { Test } from '@nestjs/testing';
import { ChartinkProcessService } from '../chartink-process.service';
import { ChartinkRepository } from '../../repositories/chartink.repository';
import { MarketDataRepository } from '../../../market-data/repositories/market-data.repository';
import { SignalGeneratorService } from '../../../signal-generator/services/signal-generator.service';
import { SetupTrackerService } from '../../../signal-generator/services/setup-tracker.service';

describe('ChartinkProcessService', () => {
  let service: ChartinkProcessService;
  let repo: { createAlertSetup: jest.Mock };
  let mdRepo: { getInstrumentBySymbol: jest.Mock };
  let signalSvc: { analyze: jest.Mock };
  let tracker: { getActive: jest.Mock };

  beforeEach(async () => {
    repo = { createAlertSetup: jest.fn().mockResolvedValue(undefined) };
    mdRepo = { getInstrumentBySymbol: jest.fn() };
    signalSvc = { analyze: jest.fn() };
    tracker = { getActive: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChartinkProcessService,
        { provide: ChartinkRepository, useValue: repo },
        { provide: MarketDataRepository, useValue: mdRepo },
        { provide: SignalGeneratorService, useValue: signalSvc },
        { provide: SetupTrackerService, useValue: tracker },
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
      rejectReason: 'symbol not in local DB',
    });
    expect(signalSvc.analyze).not.toHaveBeenCalled();
  });

  it('persists kind=setup when analyze returns a setup', async () => {
    mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'i1', token: '2885' });
    signalSvc.analyze.mockResolvedValue({ kind: 'setup', symbol: 'RELIANCE' });
    tracker.getActive.mockReturnValue({ id: 'setup-xyz' });

    await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 1467.4 });

    expect(signalSvc.analyze).toHaveBeenCalledWith('2885', 'NSE', 'RELIANCE', '15m');
    expect(repo.createAlertSetup).toHaveBeenCalledWith({
      alertId: 'alert-1',
      symbol: 'RELIANCE',
      token: '2885',
      hitPrice: 1467.4,
      kind: 'setup',
      setupId: 'setup-xyz',
      rejectReason: null,
    });
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
});
