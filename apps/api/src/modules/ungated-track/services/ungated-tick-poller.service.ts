import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { UngatedWatchRepository } from '../repositories/ungated-watch.repository';
import { UngatedWatchService } from './ungated-watch.service';

/**
 * REST-poll ungated open positions every 30 seconds during market hours.
 *
 * Why this exists: the broker's WebSocket subscription is capped around
 * 50 tokens, which the gated track already saturates (open positions +
 * NIFTY sectoral indices + chartink scanner rotation). Subscribing the
 * 40-slot ungated pool on top dropped silently — entries opened but
 * never received a single tick, so the 0.4% loss-cut and the
 * +1% partial-exit / target-hit transitions never fired.
 *
 * Path 2 (this file) sidesteps the cap entirely: one batched LTP call
 * fetches all open ungated tokens at once, then each `(token, ltp)`
 * routes through the existing `UngatedWatchService.onTick` which
 * already handles transitions idempotently.
 *
 * Trade-off vs WS: SL/target/partial-exit/trail fire within ≤ 30s of
 * breach instead of within seconds. Intra-30s peaks aren't captured on
 * the trailing-stop high-water — acceptable for the A/B experiment.
 */
@Injectable()
export class UngatedTickPoller {
  private readonly logger = new Logger(UngatedTickPoller.name);

  constructor(
    private readonly adapter: AngelOneAdapterService,
    private readonly repo: UngatedWatchRepository,
    private readonly watch: UngatedWatchService,
  ) {}

  // Every 30s, Mon–Fri, 09:15–15:30 IST. The cron format is
  // `sec min hour dow` — 6-field crontab. Pacing matches the spec's
  // documented 30-second poll cadence.
  @Cron('*/30 * 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async pollOpenPositions(): Promise<void> {
    const open = await this.repo.findAllActive();
    const traded = open.filter((e) => e.status === 'TRADED');
    if (traded.length === 0) return;

    // Group by exchange. The ungated track is equity-only (spec §5.3),
    // so in practice this is one bucket: NSE. But keep the loop generic
    // in case a future fix relaxes that.
    const byExchange = new Map<string, string[]>();
    const tokenToEntries = new Map<string, typeof traded>();
    for (const e of traded) {
      const list = byExchange.get(e.exchange) ?? [];
      list.push(e.token);
      byExchange.set(e.exchange, list);
      const arr = tokenToEntries.get(e.token) ?? [];
      arr.push(e);
      tokenToEntries.set(e.token, arr);
    }

    const now = new Date();
    let dispatched = 0;
    for (const [exchange, tokens] of byExchange) {
      const ltps = await this.adapter.getLtpsBatch(exchange, tokens);
      for (const [token, ltp] of ltps) {
        try {
          await this.watch.onTick(token, ltp, now);
          dispatched++;
        } catch (err) {
          this.logger.warn(
            `[ungated-poll] onTick(${token}) threw: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
    if (dispatched > 0) {
      this.logger.debug(
        `[ungated-poll] ${dispatched} ticks dispatched across ${traded.length} open entries`,
      );
    }
  }
}
