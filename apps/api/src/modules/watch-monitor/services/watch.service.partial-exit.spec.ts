/**
 * Unit tests for WatchService partial-exit + trailing-stop logic.
 *
 * Coverage:
 *  1. BUY entry at +9.99% does NOT trigger partial exit
 *  2. BUY entry at +10.00% triggers partial exit; sets partialExitedAt,
 *     partialQty=25, remainingQty=25, trailingStopPrice = ltp × 0.98
 *  3. SELL entry at −10.00% (in their favor) triggers partial exit;
 *     trailingStopPrice = ltp × 1.02
 *  4. After partial exit, BUY: price rises 5% more → trailingHighWater
 *     updates, stop ratchets up
 *  5. After partial exit, BUY: price drops back below stop → triggerTrailingStop
 *     fires, status=EXITED, closedReason='trailing-stop'
 *  6. Options entry (optionsToken set) → partial exit logic SKIPPED entirely
 *  7. WATCHING entry → partial exit logic SKIPPED (only TRADED)
 */
import { Test } from '@nestjs/testing';
import { WatchService } from './watch.service';
import { WatchRepository } from '../repositories/watch.repository';
import { TargetCalculatorService } from './target-calculator.service';
import { StrikeSelectorService } from './strike-selector.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { LevelBookService } from '../../signal-generator/services/level-book.service';
import { WatchGateway } from '../gateways/watch.gateway';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';

// ---- helpers ----------------------------------------------------------------

function makeEntry(overrides: Partial<Record<string, any>> = {}): Record<string, any> {
  return {
    id: 'w1',
    token: '11536',
    symbol: 'RELIANCE-EQ',
    exchange: 'NSE',
    side: 'BUY',
    status: 'TRADED',
    initialPrice: 1000,
    executedPrice: 1000,
    profitTarget: 1100,
    optionsToken: null,
    optionsLotSize: null,
    partialExitedAt: null,
    trailingHighWater: null,
    trailingStopPrice: null,
    remainingQty: null,
    maxFavorable: 1000,
    maxAdverse: 1000,
    lastEventPrice: 1000,
    lastTickAt: null,
    ...overrides,
  };
}

// ---- shared mock factories ---------------------------------------------------

function makeRepo() {
  return {
    findActiveByToken: jest.fn(),
    findById: jest.fn().mockResolvedValue({ id: 'w1', token: '11536', optionsToken: null }),
    createEvent: jest.fn().mockResolvedValue({ id: 'e1' }),
    update: jest.fn().mockResolvedValue({}),
  };
}

function makeTrade() {
  return { executeTrade: jest.fn().mockResolvedValue({ id: 't1' }), closeTrade: jest.fn().mockResolvedValue({}) };
}

function makeFeed() {
  return { subscribeForWatch: jest.fn(), unsubscribeForWatch: jest.fn() };
}

function makeGateway() {
  return { emitTick: jest.fn(), emitEvent: jest.fn(), emitCreated: jest.fn() };
}

async function buildService(repo: any, trade: any, feed: any, gateway: any): Promise<WatchService> {
  const mod = await Test.createTestingModule({
    providers: [
      WatchService,
      { provide: WatchRepository, useValue: repo },
      { provide: TargetCalculatorService, useValue: { compute: jest.fn() } },
      { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
      { provide: MarketFeedService, useValue: feed },
      { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
      { provide: WatchGateway, useValue: gateway },
      { provide: TradeExecutionService, useValue: trade },
    ],
  }).compile();
  return mod.get(WatchService);
}

// ---- tests ------------------------------------------------------------------

describe('WatchService — partial-exit + trailing-stop', () => {
  let repo: ReturnType<typeof makeRepo>;
  let trade: ReturnType<typeof makeTrade>;
  let feed: ReturnType<typeof makeFeed>;
  let gateway: ReturnType<typeof makeGateway>;
  let svc: WatchService;

  beforeEach(async () => {
    repo = makeRepo();
    trade = makeTrade();
    feed = makeFeed();
    gateway = makeGateway();
    svc = await buildService(repo, trade, feed, gateway);
  });

  // 1. BUY entry at +9.99% does NOT trigger partial exit -------------------
  it('BUY at +9.99% does NOT trigger partial exit', async () => {
    const entry = makeEntry({ side: 'BUY', executedPrice: 1000 });
    repo.findActiveByToken.mockResolvedValue([entry]);

    // ltp = 1000 * 1.0999 = 1099.9 → move = 9.99%, below 10% threshold
    await svc.onTick('11536', 1099.9, new Date());

    const partialExitUpdate = (repo.update.mock.calls as any[]).find(
      (call: any[]) => call[1]?.partialExitedAt,
    );
    expect(partialExitUpdate).toBeUndefined();

    const partialExitEvent = (repo.createEvent.mock.calls as any[]).find(
      (call: any[]) => call[0]?.eventType === 'PARTIAL_EXIT',
    );
    expect(partialExitEvent).toBeUndefined();
  });

  // 2. BUY entry at +10.00% triggers partial exit --------------------------
  it('BUY at exactly +10.00% triggers partial exit with correct fields', async () => {
    // profitTarget is set above the test ltp so TARGET_HIT does not fire first
    const entry = makeEntry({ side: 'BUY', executedPrice: 1000, profitTarget: 1300 });
    repo.findActiveByToken.mockResolvedValue([entry]);

    // ltp = 1100 → move = 10.00%, exactly at threshold
    await svc.onTick('11536', 1100, new Date());

    // Should have called executeTrade (SELL, 25 shares) for partial close
    expect(trade.executeTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        side: 'SELL',
        quantity: 25,
        orderType: 'MARKET',
      }),
    );

    // Should have written a PARTIAL_EXIT event
    expect(repo.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'PARTIAL_EXIT', price: 1100 }),
    );

    // Should have updated the entry with correct partial-exit fields
    expect(repo.update).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({
        partialExitedAt: expect.any(Date),
        partialExitPrice: 1100,
        partialQty: 25,
        remainingQty: 25,
        trailingHighWater: 1100,
        trailingStopPrice: expect.closeTo(1100 * 0.98, 4),
      }),
    );
  });

  // 3. SELL entry at −10.00% triggers partial exit -------------------------
  it('SELL at −10.00% triggers partial exit; trailingStopPrice = ltp × 1.02', async () => {
    // profitTarget for SELL is below ltp direction; set well below ltp so
    // TARGET_HIT (ltp <= profitTarget) does not fire at ltp=900.
    // SELL target hit fires when ltp <= profitTarget, so set profitTarget=700 (below 900).
    const entry = makeEntry({
      side: 'SELL',
      executedPrice: 1000,
      profitTarget: 700,
      maxFavorable: 1000,
      maxAdverse: 1000,
    });
    repo.findActiveByToken.mockResolvedValue([entry]);

    // ltp = 900 → move = (1000-900)/1000 = 10%, exactly at threshold
    await svc.onTick('11536', 900, new Date());

    // Partial close should be BUY (opposite of SELL)
    expect(trade.executeTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        side: 'BUY',
        quantity: 25,
      }),
    );

    // trailingStopPrice for SELL = ltp × 1.02
    expect(repo.update).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({
        partialQty: 25,
        remainingQty: 25,
        trailingHighWater: 900,
        trailingStopPrice: expect.closeTo(900 * 1.02, 4),
      }),
    );
  });

  // 4. After partial exit, BUY: price rises → trailingHighWater ratchets up --
  it('After partial exit, BUY: new high ratchets trailingHighWater + stop', async () => {
    // Entry already has partial exit at 1100, highWater=1100, stop=1078.
    // profitTarget must be ABOVE the test ltp (1155) so TARGET_HIT does not fire.
    const entry = makeEntry({
      side: 'BUY',
      executedPrice: 1000,
      profitTarget: 1500,
      partialExitedAt: new Date(),
      partialExitPrice: 1100,
      partialQty: 25,
      remainingQty: 25,
      trailingHighWater: 1100,
      trailingStopPrice: 1100 * 0.98, // 1078
    });
    repo.findActiveByToken.mockResolvedValue([entry]);

    // Price rises to 1155 (another +5% from partial exit price)
    await svc.onTick('11536', 1155, new Date());

    // High-water should update to 1155, stop to 1155 × 0.98
    expect(repo.update).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({
        trailingHighWater: 1155,
        trailingStopPrice: expect.closeTo(1155 * 0.98, 4),
      }),
    );

    // Should NOT have triggered trailing stop (stop = 1131.9, price = 1155 > stop)
    const trailStopEvent = (repo.createEvent.mock.calls as any[]).find(
      (call: any[]) => call[0]?.eventType === 'TRAILING_STOP_HIT',
    );
    expect(trailStopEvent).toBeUndefined();
  });

  // 5. After partial exit, BUY: price drops below stop → EXITED -------------
  it('After partial exit, BUY: price drops below trailing stop → EXITED', async () => {
    // High-water = 1155, stop = 1155 × 0.98 = 1131.9.
    // profitTarget must be ABOVE ltp (1130) so TARGET_HIT does not fire first.
    const trailStop = 1155 * 0.98;
    const entry = makeEntry({
      side: 'BUY',
      executedPrice: 1000,
      profitTarget: 1500,
      partialExitedAt: new Date(),
      partialExitPrice: 1100,
      partialQty: 25,
      remainingQty: 25,
      trailingHighWater: 1155,
      trailingStopPrice: trailStop,
    });
    repo.findActiveByToken.mockResolvedValue([entry]);

    // Price drops to 1130 — below stop (1131.9)
    await svc.onTick('11536', 1130, new Date());

    // Should close remaining 25 shares via broker
    expect(trade.executeTrade).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'SELL', quantity: 25 }),
    );

    // TRAILING_STOP_HIT event
    expect(repo.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'TRAILING_STOP_HIT', price: 1130 }),
    );

    // Status → EXITED, closedReason → 'trailing-stop'
    expect(repo.update).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({
        status: 'EXITED',
        closedReason: 'trailing-stop',
      }),
    );

    // Feed unsubscribed
    expect(feed.unsubscribeForWatch).toHaveBeenCalled();
  });

  // 6. Options entry → partial exit logic SKIPPED --------------------------
  it('Options entry (optionsToken set) skips partial exit even at +20%', async () => {
    const entry = makeEntry({
      side: 'BUY',
      executedPrice: 1000,
      profitTarget: 2000,
      optionsToken: 'OPT-TOKEN', // <-- options entry
      optionsLotSize: 75,
    });
    repo.findActiveByToken.mockResolvedValue([entry]);

    // +20% move that would normally trigger partial exit
    await svc.onTick('OPT-TOKEN', 1200, new Date());

    const partialExitEvent = (repo.createEvent.mock.calls as any[]).find(
      (call: any[]) => call[0]?.eventType === 'PARTIAL_EXIT',
    );
    expect(partialExitEvent).toBeUndefined();
    expect(trade.executeTrade).not.toHaveBeenCalled();
  });

  // 7. WATCHING entry → partial exit logic SKIPPED -------------------------
  it('WATCHING entry skips partial exit entirely', async () => {
    const entry = makeEntry({
      side: 'BUY',
      status: 'WATCHING', // <-- not TRADED
      executedPrice: null,
      profitTarget: 2000, // well above test ltp so TARGET_HIT also doesn't fire
    });
    repo.findActiveByToken.mockResolvedValue([entry]);

    // +15% move
    await svc.onTick('11536', 1150, new Date());

    const partialExitEvent = (repo.createEvent.mock.calls as any[]).find(
      (call: any[]) => call[0]?.eventType === 'PARTIAL_EXIT',
    );
    expect(partialExitEvent).toBeUndefined();
    expect(trade.executeTrade).not.toHaveBeenCalled();
  });
});
