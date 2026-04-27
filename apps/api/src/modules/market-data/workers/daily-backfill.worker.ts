import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AngelOneAdapterService } from '../services/angel-one-adapter.service';
import { MarketDataRepository } from '../repositories/market-data.repository';

interface BackfillTarget {
  symbol: string;
  token: string;
  exchange: string;
  timeframes: string[];
}

/**
 * Symbols + timeframes the daily cron keeps current. Mirrors what
 * scripts/backfill-candles.mjs uses; extending this is a one-line edit.
 */
const TARGETS: BackfillTarget[] = [
  { symbol: 'NIFTY', token: '99926000', exchange: 'NSE', timeframes: ['1d', '1h', '15m', '5m'] },
  { symbol: 'BANKNIFTY', token: '99926009', exchange: 'NSE', timeframes: ['1d', '1h', '15m', '5m'] },
];

/** Stay comfortably under Angel One's documented 1 req/sec historical-API cap. */
const RATE_LIMIT_MS = 1200;

/**
 * Daily incremental backfill of candle history from Angel One.
 *
 * WHY: live ticks → CandleAggregator → DB only persists candles while the
 * api process is up AND the market is open. Any downtime (overnight, restart,
 * server crash, weekend) leaves a gap. This worker fires at 15:35 IST every
 * weekday — five minutes after market close, so the day's last 15-min bar has
 * been sealed — and asks the broker's historical API for everything from
 * `MAX(timestamp) in DB` to `now`. Idempotent via skipDuplicates, so re-runs
 * are safe.
 *
 * Operationally this is the missing piece between "tick stream is live" and
 * "DB always has a complete history." Together with the on-startup backfill
 * (yet to be added) it eliminates the data-gap class of bugs entirely.
 */
@Injectable()
export class DailyBackfillWorker {
  private readonly logger = new Logger(DailyBackfillWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapter: AngelOneAdapterService,
    private readonly repo: MarketDataRepository,
  ) {}

  /**
   * 15:35 IST, Mon-Fri (`0 35 15 * * 1-5` with TZ).
   * Five-minute buffer past 15:30 close so the broker has finalised the
   * last bar of the session.
   */
  @Cron('0 35 15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async runDailyBackfill(): Promise<void> {
    this.logger.log('Daily candle backfill starting');
    const startedAt = Date.now();
    let totalInserted = 0;
    let totalFailed = 0;

    for (const target of TARGETS) {
      const instrument = await this.prisma.instrument.findFirst({
        where: { token: target.token, exchange: target.exchange },
        select: { id: true },
      });
      if (!instrument) {
        this.logger.warn(
          `No instrument row for ${target.symbol} (${target.token}/${target.exchange}); skipping`,
        );
        continue;
      }

      for (const tf of target.timeframes) {
        try {
          const inserted = await this.backfillOne(target, instrument.id, tf);
          totalInserted += inserted;
        } catch (err) {
          totalFailed += 1;
          this.logger.error(
            `${target.symbol}/${tf} failed: ${err instanceof Error ? err.message : err}`,
          );
        }
        await this.sleep(RATE_LIMIT_MS);
      }
    }

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    this.logger.log(
      `Daily candle backfill complete in ${elapsedSec}s — inserted=${totalInserted} failed=${totalFailed}`,
    );
  }

  /**
   * For one (instrument, timeframe), fetch from `MAX(timestamp)` to now.
   * If the table has nothing yet, fall back to the past 7 days; deeper
   * history is the job of the one-shot backfill script, not the cron.
   */
  private async backfillOne(
    target: BackfillTarget,
    instrumentId: string,
    timeframe: string,
  ): Promise<number> {
    const last = await this.prisma.candle.findFirst({
      where: { instrumentId, timeframe },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true },
    });

    const from = last?.timestamp ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const to = new Date();

    // Skip the broker call if we're already current (saves a rate-limit slot).
    if (to.getTime() - from.getTime() < 60 * 1000) {
      this.logger.log(`${target.symbol}/${timeframe}: already current (last=${from.toISOString()})`);
      return 0;
    }

    const rows = await this.adapter.getHistoricalData(
      target.token,
      target.exchange,
      timeframe,
      from,
      to,
    );

    if (rows.length === 0) {
      this.logger.log(`${target.symbol}/${timeframe}: broker returned no rows`);
      return 0;
    }

    const saved = await this.repo.saveCandles(
      rows.map((c) => ({
        instrumentId,
        timeframe,
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
    );

    this.logger.log(
      `${target.symbol}/${timeframe}: fetched=${rows.length} inserted=${saved} (from=${from.toISOString()})`,
    );
    return saved;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
