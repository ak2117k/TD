import { Test } from '@nestjs/testing';
import { WatchMonitorService } from './watch-monitor.service';
import { WatchService } from './watch.service';
import { WatchRepository } from '../repositories/watch.repository';
import { ChartinkScoringService } from '../../chartink/services/chartink-scoring.service';
import { RiskGuardService } from './risk-guard.service';

describe('WatchMonitorService', () => {
  let svc: WatchMonitorService;
  let repo: any;
  let scoring: any;
  let watch: any;
  let riskGuard: any;

  beforeEach(async () => {
    repo = {
      findAllActive: jest.fn(),
      createEvent: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    };
    scoring = { score: jest.fn() };
    watch = { transitionStopped: jest.fn() };
    riskGuard = { checkAndTrip: jest.fn().mockResolvedValue(false) };
    const mod = await Test.createTestingModule({
      providers: [
        WatchMonitorService,
        { provide: WatchRepository, useValue: repo },
        { provide: ChartinkScoringService, useValue: scoring },
        { provide: WatchService, useValue: watch },
        { provide: RiskGuardService, useValue: riskGuard },
      ],
    }).compile();
    svc = mod.get(WatchMonitorService);
  });

  /** A createdAt safely outside the 10-min grace window (created 30 min ago). */
  const wellPastGrace = () => new Date(Date.now() - 30 * 60_000);
  /** A createdAt inside the 10-min grace window (created 2 min ago). */
  const insideGrace = () => new Date(Date.now() - 2 * 60_000);

  it('writes SCORE_CHANGE event when score changes', async () => {
    scoring.score.mockResolvedValue({
      score: 75, lotCount: 2,
      checks: [{ name: 'sector', passed: true, points: 10, detail: 'ok' }],
    });
    await svc.rescoreOne({
      id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
      initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
      createdAt: wellPastGrace(),
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
      initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
      createdAt: wellPastGrace(),
    } as any);
    expect(repo.createEvent).not.toHaveBeenCalled();
  });

  it('triggers transitionStopped when score < stopLossScore (outside grace window)', async () => {
    scoring.score.mockResolvedValue({
      score: 45, lotCount: 1,
      checks: [{ name: 'sector', passed: true, points: 10, detail: 'ok' }],
    });
    await svc.rescoreOne({
      id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
      initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
      createdAt: wellPastGrace(),
    } as any);
    expect(watch.transitionStopped).toHaveBeenCalledWith('w1', 45, 'score-decay');
  });

  it('writes notes="rescore-throttled" when scoring throws rate-limit error', async () => {
    scoring.score.mockRejectedValue(new Error('rate-limit'));
    await svc.rescoreOne({
      id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
      initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
      createdAt: wellPastGrace(),
    } as any);
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      notes: expect.stringContaining('rescore-throttled'),
    }));
  });

  // ─── Task 4: 10-minute grace period ───────────────────────────────────────

  describe('score-decay grace period (first 10 minutes)', () => {
    it('does NOT trigger transitionStopped within 10 min of creation, even if score < stopLossScore', async () => {
      scoring.score.mockResolvedValue({
        score: 30, lotCount: 0,
        checks: [{ name: 'sector', passed: false, points: 0, detail: 'weak' }],
      });
      await svc.rescoreOne({
        id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
        initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
        createdAt: insideGrace(),
      } as any);
      expect(watch.transitionStopped).not.toHaveBeenCalled();
    });

    it('still updates currentScore during the grace window', async () => {
      scoring.score.mockResolvedValue({
        score: 30, lotCount: 0,
        checks: [{ name: 'sector', passed: false, points: 0, detail: 'weak' }],
      });
      await svc.rescoreOne({
        id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
        initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
        createdAt: insideGrace(),
      } as any);
      expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
        currentScore: 30, lastRescoreAt: expect.any(Date),
      }));
    });

    it('uses initialAt when createdAt is absent for the grace check', async () => {
      scoring.score.mockResolvedValue({
        score: 30, lotCount: 0,
        checks: [{ name: 'sector', passed: false, points: 0, detail: 'weak' }],
      });
      await svc.rescoreOne({
        id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
        initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
        initialAt: insideGrace(),
      } as any);
      expect(watch.transitionStopped).not.toHaveBeenCalled();
    });
  });

  // ─── Task 5: skip data-starved re-scores ──────────────────────────────────

  describe('data-starved re-score skip', () => {
    it('SKIPS the re-score entirely when result.dataStarved is true', async () => {
      scoring.score.mockResolvedValue({
        score: 20, lotCount: 0, dataStarved: true,
        checks: [{ name: 'sector', passed: false, points: 0, detail: 'no data' }],
      });
      await svc.rescoreOne({
        id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
        initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
        createdAt: wellPastGrace(),
      } as any);
      // Entry left untouched: no currentScore write, no stop.
      expect(repo.update).not.toHaveBeenCalledWith('w1', expect.objectContaining({
        currentScore: expect.anything(),
      }));
      expect(watch.transitionStopped).not.toHaveBeenCalled();
    });

    it('NEVER stops an entry on a data-starved score (even outside grace, score < stop)', async () => {
      scoring.score.mockResolvedValue({
        score: 10, lotCount: 0, dataStarved: true,
        checks: [],
      });
      await svc.rescoreOne({
        id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
        initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
        createdAt: wellPastGrace(),
      } as any);
      expect(watch.transitionStopped).not.toHaveBeenCalled();
    });

    it('processes the re-score normally when dataStarved is false', async () => {
      scoring.score.mockResolvedValue({
        score: 80, lotCount: 3, dataStarved: false,
        checks: [{ name: 'sector', passed: true, points: 10, detail: 'ok' }],
      });
      await svc.rescoreOne({
        id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
        initialPrice: 4000, currentPrice: 4010, currentScore: 72, stopLossScore: 50,
        createdAt: wellPastGrace(),
      } as any);
      expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
        currentScore: 80,
      }));
    });
  });
});
