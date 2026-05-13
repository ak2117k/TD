import { Test } from '@nestjs/testing';
import { WatchMonitorService } from './watch-monitor.service';
import { WatchService } from './watch.service';
import { WatchRepository } from '../repositories/watch.repository';
import { ChartinkScoringService } from '../../chartink/services/chartink-scoring.service';

describe('WatchMonitorService', () => {
  let svc: WatchMonitorService;
  let repo: any;
  let scoring: any;
  let watch: any;

  beforeEach(async () => {
    repo = {
      findAllActive: jest.fn(),
      createEvent: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    };
    scoring = { score: jest.fn() };
    watch = { transitionStopped: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        WatchMonitorService,
        { provide: WatchRepository, useValue: repo },
        { provide: ChartinkScoringService, useValue: scoring },
        { provide: WatchService, useValue: watch },
      ],
    }).compile();
    svc = mod.get(WatchMonitorService);
  });

  it('writes SCORE_CHANGE event when score changes', async () => {
    scoring.score.mockResolvedValue({
      score: 75, lotCount: 2,
      checks: [{ name: 'sector', passed: true, points: 10, detail: 'ok' }],
    });
    await svc.rescoreOne({
      id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
      initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 60,
    } as any);
    expect(repo.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'SCORE_CHANGE', score: 75, scoreDelta: 3,
    }));
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      currentScore: 75, lastRescoreAt: expect.any(Date),
    }));
  });

  it('does NOT write event when score unchanged', async () => {
    scoring.score.mockResolvedValue({
      score: 72, lotCount: 2,
      checks: [{ name: 'sector', passed: true, points: 10, detail: 'ok' }],
    });
    await svc.rescoreOne({
      id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
      initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 60,
    } as any);
    expect(repo.createEvent).not.toHaveBeenCalled();
  });

  it('triggers transitionStopped when score < stopLossScore', async () => {
    scoring.score.mockResolvedValue({
      score: 55, lotCount: 1,
      checks: [{ name: 'sector', passed: true, points: 10, detail: 'ok' }],
    });
    await svc.rescoreOne({
      id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
      initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 60,
    } as any);
    expect(watch.transitionStopped).toHaveBeenCalledWith('w1', 55, 'score-decay');
  });

  it('writes notes="rescore-throttled" when scoring throws rate-limit error', async () => {
    scoring.score.mockRejectedValue(new Error('rate-limit'));
    await svc.rescoreOne({
      id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
      initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 60,
    } as any);
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      notes: expect.stringContaining('rescore-throttled'),
    }));
  });
});
