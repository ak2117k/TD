import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LevelBookService } from './level-book.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TIMEFRAMES } from '@td/shared/constants';

const UNIVERSE: Array<{ token: string; symbol: string; exchange: string }> = [
  // Indices
  { token: '99926000', symbol: 'NIFTY', exchange: 'NSE' },
  { token: '99926009', symbol: 'BANKNIFTY', exchange: 'NSE' },
  { token: '99926037', symbol: 'FINNIFTY', exchange: 'NSE' },
  // MCX commodities (top by liquidity)
  { token: '486502', symbol: 'CRUDEOIL', exchange: 'MCX' },
  { token: '488791', symbol: 'COPPER', exchange: 'MCX' },
  // Stocks: keep small in v1; expand once stocks-options decision lands
  // (Decision Log #9 in spec: cash market or stock-future, not stock options)
];

@Injectable()
export class LevelBookCron {
  private readonly logger = new Logger(LevelBookCron.name);

  constructor(
    private readonly levelBook: LevelBookService,
    private readonly prisma: PrismaService,
  ) {}

  /** 09:15 IST Mon-Fri — seed PDH/PDL/ATR for the day's universe. */
  @Cron('0 15 9 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async seedSession(): Promise<void> {
    this.logger.log('Seeding level books for the session');
    for (const u of UNIVERSE) {
      try {
        const inst = await this.prisma.instrument.findFirst({
          where: { token: u.token, exchange: u.exchange },
          select: { id: true },
        });
        if (!inst) {
          this.logger.warn(`No instrument row for ${u.symbol}; skipping`);
          continue;
        }
        const recent = await this.prisma.candle.findMany({
          where: { instrumentId: inst.id, timeframe: TIMEFRAMES.ONE_DAY },
          orderBy: { timestamp: 'desc' },
          take: 16,
        });
        if (recent.length === 0) {
          this.logger.warn(`No daily candles for ${u.symbol}; skipping`);
          continue;
        }
        this.levelBook.seedSession({
          token: u.token, symbol: u.symbol, exchange: u.exchange,
          recentDailyCandles: recent
            .reverse()
            .map((c) => ({
              timestamp: c.timestamp,
              open: c.open, high: c.high, low: c.low, close: c.close,
              volume: Number(c.volume),
            })),
        });
      } catch (err) {
        this.logger.error(
          `seedSession ${u.symbol} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    this.logger.log(`Seeded ${UNIVERSE.length} level books`);
  }

  /** 09:30 IST Mon-Fri — lock the opening range from the first 15-min candle. */
  @Cron('0 30 9 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async lockOpeningRange(): Promise<void> {
    this.logger.log('Locking opening ranges');
    for (const u of UNIVERSE) {
      try {
        const inst = await this.prisma.instrument.findFirst({
          where: { token: u.token, exchange: u.exchange },
          select: { id: true },
        });
        if (!inst) continue;
        // The 09:15-09:30 IST candle is timestamp = 03:45 UTC of today
        const today = new Date();
        today.setUTCHours(3, 45, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setUTCMinutes(today.getUTCMinutes() + 15);
        const orCandle = await this.prisma.candle.findFirst({
          where: {
            instrumentId: inst.id,
            timeframe: TIMEFRAMES.FIFTEEN_MIN,
            timestamp: { gte: today, lt: tomorrow },
          },
        });
        if (!orCandle) {
          this.logger.warn(`No OR 15m candle for ${u.symbol} yet; skipping`);
          continue;
        }
        this.levelBook.lockOpeningRange(u.token, {
          high: orCandle.high, low: orCandle.low,
        });
      } catch (err) {
        this.logger.error(
          `lockOpeningRange ${u.symbol} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}
