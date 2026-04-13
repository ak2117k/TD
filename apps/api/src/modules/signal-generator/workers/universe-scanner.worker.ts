import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';
import { OptionStrikeSelectorService } from '../../options-chain/services/option-strike-selector.service';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';
import { AnandSniperV25CombinedStrategy } from '../strategies/anand-sniper-v25-combined.strategy';
import {
  CandleData,
  MarketSnapshot,
  SignalOutput,
} from '../../../common/interfaces/trading-strategy.interface';
import { OrderSideDto, OrderTypeDto, PositionTypeDto } from '../../trade-engine/dto/trade.dto';

/**
 * Watches NIFTY and BANKNIFTY 15m bar closes, runs the combined Sniper+V25
 * strategy on the latest candles, and auto-places a paper trade on the
 * best-scoring CE/PE strike when the rule fires. Trades are then enqueued
 * to the signal-review queue so Claude can post-trade audit them and kill
 * any rejected positions.
 *
 * Phase 1 scope: NIFTY + BANKNIFTY only, 15m timeframe only, transition-only
 * firing (the strategy itself dedupes consecutive same-direction signals).
 * Adding F&O stocks is a Phase-2 swap-in for the scan loop.
 */

interface WatchedSymbol {
  underlying: string;     // 'NIFTY' / 'BANKNIFTY'
  exchange: string;       // 'NSE'
  lotSize: number;        // quantity per lot for option orders
  instrumentId?: string;  // resolved at OnModuleInit
}

const WATCHED: WatchedSymbol[] = [
  { underlying: 'NIFTY', exchange: 'NSE', lotSize: 75 },
  { underlying: 'BANKNIFTY', exchange: 'NSE', lotSize: 30 },
];

const TIMEFRAMES = ['1m', '5m', '15m', '60m'] as const;
const MIN_CANDLES_PER_TF = 60;
const STALENESS_THRESHOLD_MIN = 30; // skip a symbol if its newest 15m bar is older than this

@Injectable()
export class UniverseScannerWorker implements OnModuleInit {
  private readonly logger = new Logger(UniverseScannerWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketDataRepo: MarketDataRepository,
    private readonly optionsChainService: OptionsChainService,
    private readonly strikeSelector: OptionStrikeSelectorService,
    private readonly strategy: AnandSniperV25CombinedStrategy,
    private readonly tradeExecutionService: TradeExecutionService,
    @InjectQueue('signal-review') private readonly reviewQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    // Resolve underlying instrument IDs once at boot. The candle backfill
    // script seeds these rows; if either is missing, the scan will skip
    // that symbol with a warning.
    for (const w of WATCHED) {
      // Match either 'INDEX' or 'INDICES' segment label — different parts of
      // the codebase have used both historically (the backfill script writes
      // 'INDEX', the older WS subscriber wrote 'INDICES').
      const inst = await this.prisma.instrument.findFirst({
        where: {
          symbol: w.underlying,
          exchange: w.exchange,
          segment: { in: ['INDEX', 'INDICES'] },
        },
      });
      if (inst) {
        w.instrumentId = inst.id;
        this.logger.log(`Resolved ${w.underlying} → instrumentId=${inst.id}`);
      } else {
        this.logger.warn(
          `${w.underlying} not in instruments table — scanner will skip it. ` +
          `Run scripts/backfill-candles.mjs once to seed the index row.`,
        );
      }
    }
  }

  /**
   * Cron: every 15 minutes at the bar close (3:30s past the quarter to give
   * the broker a beat to settle the bar). Only fires during NSE market hours
   * IST (09:15-15:30, Mon-Fri).
   */
  @Cron('30 */15 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async scanCron(): Promise<void> {
    this.logger.log('Universe scan tick');
    for (const w of WATCHED) {
      try {
        await this.scanSymbol(w);
      } catch (err) {
        this.logger.error(
          `Scan failed for ${w.underlying}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  /**
   * Manual trigger — useful for smoke testing without waiting for the cron.
   * Returns the signal (or null) and the resulting trade outcome (if any).
   */
  async runOnce(): Promise<Array<{ symbol: string; signal: SignalOutput | null; tradeId: string | null; reason: string }>> {
    const out: Array<{ symbol: string; signal: SignalOutput | null; tradeId: string | null; reason: string }> = [];
    for (const w of WATCHED) {
      const result = await this.scanSymbol(w);
      out.push({ symbol: w.underlying, ...result });
    }
    return out;
  }

  private async scanSymbol(
    w: WatchedSymbol,
  ): Promise<{ signal: SignalOutput | null; tradeId: string | null; reason: string }> {
    if (!w.instrumentId) {
      return { signal: null, tradeId: null, reason: 'instrument not resolved' };
    }

    // 1. Fetch MTF candles from local DB. Window: last 24h is enough for
    //    60m bars to fill 50 candles; smaller timeframes get plenty.
    const now = new Date();
    const from24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const mtfCandles: Record<string, CandleData[]> = {};
    let staleness = Infinity;

    for (const tf of TIMEFRAMES) {
      // The DB stores '1h' as the canonical name for the 60m bucket — match either.
      const tfKey = tf === '60m' ? '1h' : tf;
      const rows = await this.marketDataRepo.getCandles(
        w.instrumentId,
        tfKey,
        from24h,
        now,
      );
      const candles: CandleData[] = rows.map((r) => ({
        timestamp: r.timestamp,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: Number(r.volume),
      }));
      mtfCandles[tf] = candles;
      if (tf === '15m' && candles.length > 0) {
        const newest = candles[candles.length - 1].timestamp;
        staleness = (now.getTime() - newest.getTime()) / 60000;
      }
    }

    if ((mtfCandles['15m']?.length ?? 0) < MIN_CANDLES_PER_TF) {
      return { signal: null, tradeId: null, reason: `insufficient 15m candles (${mtfCandles['15m']?.length ?? 0})` };
    }
    if (staleness > STALENESS_THRESHOLD_MIN) {
      return { signal: null, tradeId: null, reason: `data stale by ${staleness.toFixed(0)}min` };
    }

    const candles15m = mtfCandles['15m'];
    const ltp = candles15m[candles15m.length - 1].close;
    const volume = candles15m[candles15m.length - 1].volume;

    // 2. Run the strategy. The strategy itself handles transition firing,
    //    so calling it on every cron tick is safe — it dedupes internally.
    const snapshot: MarketSnapshot = {
      symbol: w.underlying,
      exchange: w.exchange,
      ltp,
      candles: candles15m,
      mtfCandles,
      volume,
    };

    const signal = this.strategy.analyze(snapshot);
    if (!signal) {
      return { signal: null, tradeId: null, reason: 'rule did not fire' };
    }

    this.logger.log(
      `[${w.underlying}] signal fired: ${signal.side} @ ${signal.entryPrice} (confidence ${signal.confidence})`,
    );

    // 3. Pick the best strike. CE for BUY signal, PE for SELL signal.
    const expiries = await this.optionsChainService.getExpiries(w.underlying);
    if (expiries.length === 0) {
      return { signal, tradeId: null, reason: 'no expiries available for underlying' };
    }
    const expiry = expiries[0]; // nearest weekly

    const strike = await this.strikeSelector.selectBestStrike({
      underlying: w.underlying,
      expiry,
      side: signal.side === 'BUY' ? 'CE' : 'PE',
    });
    if (!strike) {
      return { signal, tradeId: null, reason: 'no viable strike in band' };
    }

    this.logger.log(
      `[${w.underlying}] selected ${strike.side} ${strike.strikePrice} @ ${strike.ltp} (score ${strike.score.toFixed(1)}) — ${strike.reason}`,
    );

    // 4. Build the ExecuteTradeDto. We use synthetic symbol+token because
    //    the option contract instruments table may be empty in this Phase-1
    //    deployment (the backfill only seeded INDEX rows, not OPTIDX). The
    //    paper trade service falls back to request.price for fills when the
    //    token isn't in its tick LTP cache, so passing strike.ltp as price
    //    gives us a clean simulated fill at the strike's last traded price.
    const expiryCompact = expiry.replace(/-/g, '').slice(2); // 2026-04-13 → 260413
    const syntheticSymbol = `${w.underlying}${expiryCompact}${strike.strikePrice}${strike.side}`;
    const syntheticToken = `PAPER-${w.underlying}-${strike.strikePrice}-${strike.side}`;

    try {
      const result = await this.tradeExecutionService.executeTrade({
        symbol: syntheticSymbol,
        token: syntheticToken,
        exchange: 'NFO',
        side: OrderSideDto.BUY, // we BUY the option (call or put), regardless of underlying direction
        orderType: OrderTypeDto.MARKET,
        quantity: w.lotSize,
        price: strike.ltp,
        positionType: PositionTypeDto.INTRADAY,
        strategy: this.strategy.name,
        // Mirror the underlying's stop/target into option-premium space using
        // delta — first-order estimate, good enough for paper trading. Actual
        // production code would manage stops at the underlying level via a
        // separate watcher.
        stoploss: Math.max(0.05, strike.ltp - Math.abs((signal.entryPrice - signal.stoplossPrice) * (strike.delta || 0.5))),
        target:   strike.ltp + Math.abs((signal.targetPrice - signal.entryPrice) * (strike.delta || 0.5)),
      } as any);

      const tradeId = (result as any)?.id ?? (result as any)?.tradeId ?? null;
      this.logger.log(
        `[${w.underlying}] paper trade placed: ${syntheticSymbol} qty=${w.lotSize} @ ${strike.ltp} → tradeId=${tradeId}`,
      );

      // 5. Enqueue Claude's post-trade review.
      if (tradeId) {
        await this.reviewQueue.add('review-trade', {
          tradeId,
          signal,
          snapshot: {
            underlying: w.underlying,
            spotPrice: strike.spotPrice,
            strikePrice: strike.strikePrice,
            side: strike.side,
            ltp: strike.ltp,
            oi: strike.oi,
            oiChange: strike.oiChange,
            volume: strike.volume,
            iv: strike.iv,
            delta: strike.delta,
            gamma: strike.gamma,
            theta: strike.theta,
            vega: strike.vega,
            scoreBreakdown: strike.scoreBreakdown,
            expiry: strike.expiry,
            confidenceFromRule: signal.confidence,
            ruleReason: signal.reason,
            ruleMetadata: signal.metadata,
          },
        });
        this.logger.log(`[${w.underlying}] enqueued signal-review for trade ${tradeId}`);
      }

      return { signal, tradeId, reason: 'trade placed' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[${w.underlying}] trade execution failed: ${msg}`);
      return { signal, tradeId: null, reason: `trade execution failed: ${msg}` };
    }
  }
}
