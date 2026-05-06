import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Prisma } from '@prisma/client';
import { ChartinkWebhookDto } from '../dto/chartink-webhook.dto';
import { ChartinkRepository } from '../repositories/chartink.repository';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

interface ParsedHit {
  symbol: string;
  hitPrice: number;
}

export interface ChartinkProcessJobData {
  alertId: string;
  hits: ParsedHit[];
}

@Injectable()
export class ChartinkIngestService {
  private readonly logger = new Logger(ChartinkIngestService.name);

  constructor(
    private readonly repo: ChartinkRepository,
    @InjectQueue('chartink-process') private readonly queue: Queue<ChartinkProcessJobData>,
  ) {}

  async ingest(payload: ChartinkWebhookDto): Promise<{ alertId: string; hitCount: number }> {
    const hits = this.parseHits(payload.stocks, payload.trigger_prices);
    const triggeredAt = this.deriveTriggeredAt(payload.triggered_at, new Date());

    const scanner = await this.repo.upsertScanner({
      scanUrl: payload.scan_url,
      scanName: payload.scan_name,
      alertName: payload.alert_name,
      firedAt: triggeredAt,
    });

    const alert = await this.repo.createAlert({
      scannerId: scanner.id,
      triggeredAt,
      rawPayload: payload as unknown as Prisma.InputJsonValue,
    });

    await this.queue.add('process', { alertId: alert.id, hits });

    this.logger.log(
      `Ingested Chartink alert ${alert.id} (${payload.scan_name}) — ${hits.length} hits`,
    );

    return { alertId: alert.id, hitCount: hits.length };
  }

  private parseHits(stocksCsv: string, pricesCsv: string): ParsedHit[] {
    const stocks = stocksCsv.split(',').map((s) => s.trim()).filter(Boolean);
    const prices = pricesCsv.split(',').map((s) => s.trim()).filter(Boolean);
    if (stocks.length !== prices.length) {
      throw new BadRequestException(
        `Chartink payload length mismatch: ${stocks.length} stocks vs ${prices.length} prices`,
      );
    }
    return stocks.map((symbol, i) => ({
      symbol,
      hitPrice: Number(prices[i]),
    }));
  }

  private deriveTriggeredAt(clockStr: string, now: Date): Date {
    const istNow = new Date(now.getTime() + IST_OFFSET_MS);
    const m = clockStr.trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
    if (!m) {
      throw new BadRequestException(`Cannot parse Chartink triggered_at: "${clockStr}"`);
    }
    let hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    const meridiem = m[3];
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    const istMidnightUtc = Date.UTC(
      istNow.getUTCFullYear(),
      istNow.getUTCMonth(),
      istNow.getUTCDate(),
      0, 0, 0, 0,
    );
    return new Date(istMidnightUtc + hour * 3600_000 + minute * 60_000 - IST_OFFSET_MS);
  }
}
