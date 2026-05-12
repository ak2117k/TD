import { Injectable, Logger } from '@nestjs/common';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

export type TfDirection = 'UP' | 'DOWN' | 'NEUTRAL';
export type Timeframe = '1d' | '1h' | '15m' | '5m';

export interface MtfResult {
  directions: Record<Timeframe, TfDirection>;
  aligned: boolean;
  agreedDirection: 'UP' | 'DOWN' | null;
  /** Human-readable summary, e.g. "1d=UP 1h=DOWN 15m=UP 5m=UP". */
  summary: string;
}

interface Candle {
  timestamp: Date;
  close: number;
}

const TIMEFRAMES: Timeframe[] = ['1d', '1h', '15m', '5m'];
const RATE_LIMIT_MS = 350;

const LOOKBACK_MS: Record<Timeframe, number> = {
  '1d': 7 * 24 * 60 * 60 * 1000,
  '1h': 24 * 60 * 60 * 1000,
  '15m': 3 * 60 * 60 * 1000,
  '5m': 1 * 60 * 60 * 1000,
};

@Injectable()
export class MtfAlignmentService {
  private readonly logger = new Logger(MtfAlignmentService.name);

  constructor(private readonly adapter: AngelOneAdapterService) {}

  async check(token: string, exchange: string): Promise<MtfResult> {
    const directions: Record<Timeframe, TfDirection> = {
      '1d': 'NEUTRAL',
      '1h': 'NEUTRAL',
      '15m': 'NEUTRAL',
      '5m': 'NEUTRAL',
    };

    const now = Date.now();
    for (let i = 0; i < TIMEFRAMES.length; i++) {
      const tf = TIMEFRAMES[i];
      directions[tf] = await this.directionForTimeframe(token, exchange, tf, now);
      if (i < TIMEFRAMES.length - 1) await this.sleep(RATE_LIMIT_MS);
    }

    // Alignment semantics: NEUTRAL is a silent voter (insufficient data or
    // exactly equal closes — no opinion). We require at least 2 of the 4
    // timeframes to have an actual opinion (non-NEUTRAL), and all
    // opinionated timeframes must agree (no UP-vs-DOWN conflict).
    //
    // Why: the strict "all 4 agree" rule was unusable in the first 30 min
    // of the trading session because the 15m timeframe needs two completed
    // bars (30 min of data) before it can compute direction. Treating
    // insufficient-data NEUTRAL as a blocker effectively shut the gate for
    // every pre-10:00 IST scanner fire. Silent NEUTRALs preserve the
    // genuine-conflict rejection (the gate's whole point) while letting
    // legitimate single-direction consensus through earlier in the session.
    const values = Object.values(directions);
    const upCount = values.filter((d) => d === 'UP').length;
    const downCount = values.filter((d) => d === 'DOWN').length;
    const opinionatedCount = upCount + downCount;
    // Need ≥ 2 opinions AND no UP-vs-DOWN conflict. Both checks are needed:
    // 4 NEUTRALs would pass "no conflict" but should still reject.
    const aligned = opinionatedCount >= 2 && (upCount === 0 || downCount === 0);
    const agreedDirection: 'UP' | 'DOWN' | null = aligned
      ? upCount > 0
        ? 'UP'
        : 'DOWN'
      : null;

    const summary = TIMEFRAMES.map((tf) => `${tf}=${directions[tf]}`).join(' ');

    return { directions, aligned, agreedDirection, summary };
  }

  private async directionForTimeframe(
    token: string,
    exchange: string,
    tf: Timeframe,
    nowMs: number,
  ): Promise<TfDirection> {
    const from = new Date(nowMs - LOOKBACK_MS[tf]);
    const to = new Date(nowMs);

    let candles: Candle[];
    try {
      candles = (await this.adapter.getHistoricalData(
        token,
        exchange,
        tf,
        from,
        to,
      )) as Candle[];
    } catch (err) {
      this.logger.warn(
        `MTF: ${tf} fetch failed for ${exchange}:${token} — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return 'NEUTRAL';
    }

    if (!candles || candles.length < 2) return 'NEUTRAL';

    let endIdx = candles.length - 1;
    if (this.isBarStillForming(candles[endIdx], nowMs)) {
      endIdx -= 1;
    }
    if (endIdx < 1) return 'NEUTRAL';

    const cur = candles[endIdx].close;
    const prev = candles[endIdx - 1].close;
    if (cur > prev) return 'UP';
    if (cur < prev) return 'DOWN';
    return 'NEUTRAL';
  }

  /**
   * A candle is treated as "still forming" only when its open-time is in
   * the future relative to our wall clock. Angel One's getCandleData
   * already returns completed historical bars stamped at bar-open time;
   * the only way we see a future-timestamped bar is when a caller mocks
   * one in (e.g. unit tests) or — in production — clock skew between
   * the API server and Angel's edge. We deliberately do NOT treat
   * "bar opened less than one timeframe ago" as still forming because
   * the historical endpoint will not return an in-progress bar in that
   * window; the most recent bar it returns is the previous completed
   * one. Trying to be too clever here drops a real signal on intraday
   * runs.
   */
  private isBarStillForming(bar: Candle, nowMs: number): boolean {
    return bar.timestamp.getTime() > nowMs;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
