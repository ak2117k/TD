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

  // Expire all WATCHING intraday entries at 15:15 IST (market close).
  @Cron('15 15 15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async expireIntradayAtClose(): Promise<void> {
    const count = await this.repo.expireAllWatchingIntraday();
    this.logger.log(`[anand-intraday] expired ${count} WATCHING entries at market close`);
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
