import { Test } from '@nestjs/testing';
import { AnandDualTrackService } from '../anand-dual-track.service';
import { AnandDualTrackRepository } from '../../repositories/anand-dual-track.repository';

describe('AnandDualTrackService', () => {
  let service: AnandDualTrackService;
  let repo: { createIntradayEntry: jest.Mock; createSwingEntry: jest.Mock };

  beforeEach(async () => {
    repo = {
      createIntradayEntry: jest.fn().mockResolvedValue({ id: 'i1' }),
      createSwingEntry: jest.fn().mockResolvedValue({ id: 's1' }),
    };

    const mod = await Test.createTestingModule({
      providers: [
        AnandDualTrackService,
        { provide: AnandDualTrackRepository, useValue: repo },
      ],
    }).compile();

    service = mod.get(AnandDualTrackService);
  });

  it('createEntries calls both repo methods with same input', async () => {
    const input = {
      alertId: 'a1', symbol: 'RELIANCE', token: '2885', hitPrice: 2500, scoreBreakdown: [{ name: 'RSI', passed: true }],
    };
    await service.createEntries(input);
    expect(repo.createIntradayEntry).toHaveBeenCalledWith({
      symbol: 'RELIANCE', token: '2885', entryPrice: 2500, alertId: 'a1', scoreBreakdown: [{ name: 'RSI', passed: true }],
    });
    expect(repo.createSwingEntry).toHaveBeenCalledWith({
      symbol: 'RELIANCE', token: '2885', entryPrice: 2500, alertId: 'a1', scoreBreakdown: [{ name: 'RSI', passed: true }],
    });
  });

  it('createEntries does not throw if one insert fails', async () => {
    repo.createSwingEntry.mockRejectedValue(new Error('DB error'));
    await expect(service.createEntries({
      alertId: 'a1', symbol: 'TCS', token: '11536', hitPrice: 3500, scoreBreakdown: null,
    })).resolves.not.toThrow();
    expect(repo.createIntradayEntry).toHaveBeenCalled();
  });
});
