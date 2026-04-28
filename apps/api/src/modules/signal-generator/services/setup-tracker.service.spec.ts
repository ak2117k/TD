import { SetupTrackerService, LockInput } from './setup-tracker.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { IndicatorReadings } from '../types/setup-context.types';

const baseIndicators: IndicatorReadings = {
  ema9: 100,
  ema21: 99,
  rsi14: 55,
  macdHistogram: 0.5,
  bollingerPosition: 0.2,
  roc10: 1.0,
  alignment: { ema: 1, rsi: 1, macd: 1, bollinger: 1, momentum: 1 },
  agreement: 5,
};

// Use a recent IST trading-hours timestamp so sessionEnded() returns false
// during the simulated tick processing. Pick 11:00 IST on a weekday.
const nextWeekday11Ist = (): Date => {
  const now = new Date();
  // 11:00 IST = 05:30 UTC
  const utc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 5, 30, 0),
  );
  // Bump to next weekday if it lands on a weekend.
  const day = utc.getUTCDay();
  if (day === 0) utc.setUTCDate(utc.getUTCDate() + 1);
  else if (day === 6) utc.setUTCDate(utc.getUTCDate() + 2);
  return utc;
};

const buyInput = (overrides?: Partial<LockInput>): LockInput => ({
  token: 'TKN-1',
  symbol: 'NIFTY',
  exchange: 'NSE',
  side: 'BUY',
  setupType: 'BREAKOUT',
  levelType: 'PDH',
  levelValue: 100,
  entry: 100,
  stoploss: 95,
  target: 115,
  partialTakeAt: 105, // entry + slDist (= 5)
  grade: 'A',
  atr14: 10,
  indicators: baseIndicators,
  higherTimeframeTrend: null,
  reason: 'test',
  ...overrides,
});

const sellInput = (overrides?: Partial<LockInput>): LockInput =>
  buyInput({
    token: 'TKN-2',
    side: 'SELL',
    levelValue: 100,
    entry: 100,
    stoploss: 105,
    target: 85,
    partialTakeAt: 95, // entry - slDist (= 5)
    ...overrides,
  });

describe('SetupTrackerService – partial-TP + trailing-SL', () => {
  let tracker: SetupTrackerService;
  let now: Date;

  beforeEach(() => {
    const stubFeed = {
      isMarketOpen: () => true,
      getQuote: () => null,
    } as unknown as MarketFeedService;
    tracker = new SetupTrackerService(stubFeed);
    now = nextWeekday11Ist();
  });

  it('BUY: ACTIVE → PARTIAL_BOOKED at 1×SL profit, trailingSl pinned to entry', () => {
    const setup = tracker.lock(buyInput())!;
    expect(setup.status).toBe('PENDING');
    // Trigger PENDING → ACTIVE
    tracker.updateFromTick('TKN-1', 100, now);
    expect(tracker.getActive('TKN-1')!.status).toBe('ACTIVE');
    // Reach partialTakeAt (105)
    tracker.updateFromTick('TKN-1', 105, new Date(now.getTime() + 1000));
    const after = tracker.getActive('TKN-1')!;
    expect(after.status).toBe('PARTIAL_BOOKED');
    expect(after.trailingSl).toBe(100); // break-even = entry
    expect(after.partialBookedAt).not.toBeNull();
  });

  it('BUY: PARTIAL_BOOKED ratchets trailingSl up as spot moves further in profit', () => {
    tracker.lock(buyInput());
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE
    tracker.updateFromTick('TKN-1', 105, new Date(now.getTime() + 1000)); // PARTIAL_BOOKED
    // Spot moves to 108 → trailingSl candidate = 108-5 = 103, which beats 100 (entry)
    tracker.updateFromTick('TKN-1', 108, new Date(now.getTime() + 2000));
    expect(tracker.getActive('TKN-1')!.trailingSl).toBe(103);
    // Spot moves to 112 → trailingSl candidate = 107
    tracker.updateFromTick('TKN-1', 112, new Date(now.getTime() + 3000));
    expect(tracker.getActive('TKN-1')!.trailingSl).toBe(107);
  });

  it('BUY: trailingSl never moves backward when spot retraces (only ratchets up)', () => {
    tracker.lock(buyInput());
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE
    tracker.updateFromTick('TKN-1', 105, new Date(now.getTime() + 1000)); // PARTIAL_BOOKED
    tracker.updateFromTick('TKN-1', 112, new Date(now.getTime() + 2000));
    expect(tracker.getActive('TKN-1')!.trailingSl).toBe(107);
    // Retrace to 109 — candidate would be 104, NOT allowed to drop trailingSl from 107
    tracker.updateFromTick('TKN-1', 109, new Date(now.getTime() + 3000));
    expect(tracker.getActive('TKN-1')!.trailingSl).toBe(107);
  });

  it('BUY: PARTIAL_BOOKED → TRAIL_STOPPED when spot crosses below trailingSl', () => {
    tracker.lock(buyInput());
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE
    tracker.updateFromTick('TKN-1', 105, new Date(now.getTime() + 1000)); // PARTIAL_BOOKED, trailingSl=100
    tracker.updateFromTick('TKN-1', 110, new Date(now.getTime() + 2000)); // ratchet to 105
    // Spot drops to 104 → below trailingSl (105) → TRAIL_STOPPED
    tracker.updateFromTick('TKN-1', 104, new Date(now.getTime() + 3000));
    const closed =
      tracker.getActive('TKN-1') ?? tracker.getHistory('TKN-1')[0];
    expect(closed.status).toBe('TRAIL_STOPPED');
    expect(closed.runnerExitAt).not.toBeNull();
  });

  it('BUY: PARTIAL_BOOKED → TARGET_HIT when spot reaches the original target', () => {
    tracker.lock(buyInput());
    tracker.updateFromTick('TKN-1', 100, now);
    tracker.updateFromTick('TKN-1', 105, new Date(now.getTime() + 1000)); // PARTIAL_BOOKED
    tracker.updateFromTick('TKN-1', 115, new Date(now.getTime() + 2000)); // TARGET_HIT
    const closed =
      tracker.getActive('TKN-1') ?? tracker.getHistory('TKN-1')[0];
    expect(closed.status).toBe('TARGET_HIT');
  });

  it('SELL: ACTIVE → PARTIAL_BOOKED at 1×SL profit, then trailingSl ratchets DOWN', () => {
    tracker.lock(sellInput());
    tracker.updateFromTick('TKN-2', 100, now); // ACTIVE
    // Reach partialTakeAt (95) — moves DOWN
    tracker.updateFromTick('TKN-2', 95, new Date(now.getTime() + 1000));
    let s = tracker.getActive('TKN-2')!;
    expect(s.status).toBe('PARTIAL_BOOKED');
    expect(s.trailingSl).toBe(100);
    // Spot moves to 92 → candidate = 92+5 = 97, which is BELOW 100 (entry) → ratchet
    tracker.updateFromTick('TKN-2', 92, new Date(now.getTime() + 2000));
    s = tracker.getActive('TKN-2')!;
    expect(s.trailingSl).toBe(97);
    // Spot moves to 88 → candidate = 93
    tracker.updateFromTick('TKN-2', 88, new Date(now.getTime() + 3000));
    s = tracker.getActive('TKN-2')!;
    expect(s.trailingSl).toBe(93);
    // Retrace UP to 90 — candidate = 95, NOT allowed (would be a backward move for SELL)
    tracker.updateFromTick('TKN-2', 90, new Date(now.getTime() + 4000));
    s = tracker.getActive('TKN-2')!;
    expect(s.trailingSl).toBe(93);
  });

  it('SELL: PARTIAL_BOOKED → TRAIL_STOPPED when spot crosses above trailingSl', () => {
    tracker.lock(sellInput());
    tracker.updateFromTick('TKN-2', 100, now);
    tracker.updateFromTick('TKN-2', 95, new Date(now.getTime() + 1000));
    tracker.updateFromTick('TKN-2', 90, new Date(now.getTime() + 2000)); // ratchet to 95
    // Spot pops to 96 — above trailingSl (95) → TRAIL_STOPPED
    tracker.updateFromTick('TKN-2', 96, new Date(now.getTime() + 3000));
    const closed =
      tracker.getActive('TKN-2') ?? tracker.getHistory('TKN-2')[0];
    expect(closed.status).toBe('TRAIL_STOPPED');
  });

  it('BUY: ACTIVE → STOPPED if spot hits SL before reaching partialTakeAt', () => {
    tracker.lock(buyInput());
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE
    tracker.updateFromTick('TKN-1', 95, new Date(now.getTime() + 1000));
    const closed =
      tracker.getActive('TKN-1') ?? tracker.getHistory('TKN-1')[0];
    expect(closed.status).toBe('STOPPED');
  });

  it('BUY: single-tick teleport past partialTakeAt to target → TARGET_HIT (target wins same-tick)', () => {
    tracker.lock(buyInput());
    tracker.updateFromTick('TKN-1', 100, now); // ACTIVE
    // Spot teleports straight to 116 — above both partialTakeAt (105) and target (115).
    // Target check is evaluated first inside ACTIVE, so the setup closes TARGET_HIT
    // without ever entering PARTIAL_BOOKED. This is the intended best-case outcome.
    tracker.updateFromTick('TKN-1', 116, new Date(now.getTime() + 1000));
    const closed =
      tracker.getActive('TKN-1') ?? tracker.getHistory('TKN-1')[0];
    expect(closed.status).toBe('TARGET_HIT');
    expect(closed.partialBookedAt).toBeNull();
  });
});
