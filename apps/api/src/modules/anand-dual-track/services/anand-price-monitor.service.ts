import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AnandDualTrackRepository } from '../repositories/anand-dual-track.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

@Injectable()
export class AnandPriceMonitorService {
  private readonly logger = new Logger(AnandPriceMonitorService.name);

  constructor(
    private readonly repo: AnandDualTrackRepository,
    private readonly adapter: AngelOneAdapterService,
  ) {}

  // Poll both tracks every 30s during market hours Mon–Fri 09:15–15:15 IST.
  @Cron('*/30 * 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async pollMarketHours(): Promise<void> {
    const [intraday, swing] = await Promise.all([
      this.repo.listWatchingIntraday(),
      this.repo.listWatchingSwing(),
    ]);

    await this.checkEntries(intraday, 'intraday');
    await this.checkEntries(swing, 'swing');
  }

  // Expire all open intraday entries at 15:15 IST (market close), marking each
  // to its last traded price. Recording exitPrice (rather than leaving it null)
  // is what makes an expired trade count toward realized P&L as its true
  // gain/loss — without it, only TARGET_HIT winners ever carried an exitPrice,
  // so the P&L summary silently summed winners only (100% win rate, inflated).
  @Cron('15 15 15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async expireIntradayAtClose(): Promise<void> {
    const entries = await this.repo.listWatchingIntraday();
    if (entries.length === 0) {
      this.logger.log('[anand-intraday] no open entries to expire at close');
      return;
    }

    const tokens = [...new Set(entries.map((e) => e.token).filter((t): t is string => !!t))];
    const ltpMap = tokens.length
      ? await this.adapter.getLtpsBatch('NSE', tokens).catch(() => new Map<string, number>())
      : new Map<string, number>();

    const now = new Date();
    let count = 0;
    for (const entry of entries) {
      const ltp = entry.token ? ltpMap.get(entry.token) : undefined;
      // Mark to market at the close LTP. Fall back to entryPrice (breakeven,
      // 0% — neither win nor loss) when no price is available, so the trade is
      // still closed and counted instead of being dropped from P&L.
      const exitPrice = ltp ?? entry.entryPrice;
      if (ltp === undefined) {
        this.logger.warn(
          `[anand-intraday] ${entry.id} (${entry.symbol}) expired with no LTP — marked breakeven at entry ${entry.entryPrice}`,
        );
      }
      await this.repo.updateIntradayStatus(entry.id, {
        status: 'EXPIRED',
        exitPrice,
        exitedAt: now,
      });
      count++;
    }
    this.logger.log(`[anand-intraday] expired ${count} entries (marked to market) at market close`);
  }

  // Poll swing entries every 10 min always; guard skips during market hours
  // (09:15–15:30 IST) since pollMarketHours covers that window.
  @Cron('0 */10 * * * *', { timeZone: 'Asia/Kolkata' })
  async pollOvernight(): Promise<void> {
    // Determine current IST hour+minute to skip the market-hours window.
    const nowUtc = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(nowUtc.getTime() + istOffsetMs);
    const istMinutes = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();

    // Market hours: 09:15–15:30 IST → 555–930 minutes-since-midnight
    const MARKET_OPEN = 9 * 60 + 15;   // 555
    const MARKET_CLOSE = 15 * 60 + 30; // 930
    if (istMinutes >= MARKET_OPEN && istMinutes < MARKET_CLOSE) {
      return; // pollMarketHours handles this window
    }

    const swing = await this.repo.listWatchingSwing();
    await this.checkEntries(swing, 'swing');
  }

  private async checkEntries(
    entries: Array<{ id: string; token: string | null; entryPrice: number; targetPct: number; stopPct: number }>,
    track: 'intraday' | 'swing',
  ): Promise<void> {
    const withToken = entries.filter((e) => e.token);
    if (withToken.length === 0) return;

    const tokens = [...new Set(withToken.map((e) => e.token as string))];
    const ltpMap = await this.adapter.getLtpsBatch('NSE', tokens).catch(() => new Map<string, number>());

    const now = new Date();
    for (const entry of withToken) {
      const ltp = ltpMap.get(entry.token as string);
      if (ltp === undefined) continue;

      const pnlPct = ((ltp - entry.entryPrice) / entry.entryPrice) * 100;

      if (pnlPct >= entry.targetPct) {
        this.logger.log(`[anand-${track}] ${entry.id} TARGET_HIT at ${ltp} (+${pnlPct.toFixed(2)}%)`);
        await (track === 'intraday'
          ? this.repo.updateIntradayStatus(entry.id, { status: 'TARGET_HIT', exitPrice: ltp, exitedAt: now })
          : this.repo.updateSwingStatus(entry.id, { status: 'TARGET_HIT', exitPrice: ltp, exitedAt: now }));
      } else if (pnlPct <= -entry.stopPct) {
        this.logger.log(`[anand-${track}] ${entry.id} STOPPED at ${ltp} (${pnlPct.toFixed(2)}%)`);
        await (track === 'intraday'
          ? this.repo.updateIntradayStatus(entry.id, { status: 'STOPPED', exitPrice: ltp, exitedAt: now })
          : this.repo.updateSwingStatus(entry.id, { status: 'STOPPED', exitPrice: ltp, exitedAt: now }));
      }
    }
  }
}
