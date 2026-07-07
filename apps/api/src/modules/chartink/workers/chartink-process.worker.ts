import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { ChartinkProcessService } from '../services/chartink-process.service';
import { ChartinkProcessJobData, ChartinkProcessHitJobData } from '../services/chartink-ingest.service';

@Processor('chartink-process')
export class ChartinkProcessWorker {
  private readonly logger = new Logger(ChartinkProcessWorker.name);

  constructor(private readonly process: ChartinkProcessService) {}

  // Bull default concurrency is 1 - Chartink alert jobs run strictly
  // serially, so the createFromAlert same-symbol reuse guard cannot race.
  // Do NOT raise concurrency without first making that guard atomic.
  @Process('process')
  async handle(job: Job<ChartinkProcessJobData>): Promise<void> {
    const { alertId, hits } = job.data;
    this.logger.log(`Worker received alert ${alertId} with ${hits.length} hits`);
    await this.process.processAlert(alertId, hits);
  }

  // Per-hit jobs (the fan-out fix): each stock is its own short job so a
  // high-volume alert can't stall a single long-running job. Concurrency stays
  // 1 (see comment above) — the createFromAlert reuse guard is still serial.
  @Process('process-hit')
  async handleHit(job: Job<ChartinkProcessHitJobData>): Promise<void> {
    const { alertId, hit, scanName, scannerCategory } = job.data;
    this.logger.log(`Worker received hit ${hit.symbol} (alert ${alertId})`);
    await this.process.processOne(alertId, hit, scanName, scannerCategory);
  }
}
