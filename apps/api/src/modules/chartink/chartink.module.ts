import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { SignalGeneratorModule } from '../signal-generator/signal-generator.module';
import { ChartinkRepository } from './repositories/chartink.repository';
import { ChartinkIngestService } from './services/chartink-ingest.service';
import { ChartinkProcessService } from './services/chartink-process.service';
import { ChartinkScoringService } from './services/chartink-scoring.service';
import { ChartinkRejectionsService } from './services/chartink-rejections.service';
import { ChartinkProcessWorker } from './workers/chartink-process.worker';
import { ChartinkWebhookController } from './controllers/chartink-webhook.controller';
import { ChartinkController } from './controllers/chartink.controller';
import { UngatedTrackModule } from '../ungated-track/ungated-track.module';
import { AdaptiveStopTrackModule } from '../adaptive-stop-track/adaptive-stop-track.module';
import { AnandDualTrackModule } from '../anand-dual-track/anand-dual-track.module';
import { BreakoutSwingTrackModule } from '../breakout-swing-track/breakout-swing-track.module';
import { SellFuturesModule } from '../sell-futures-track/sell-futures.module';

// @Global so ChartinkRepository and ChartinkScoringService are injectable
// without consumers importing this module — avoids the circular dep that would
// form if WatchMonitorModule imported ChartinkModule AND ChartinkModule
// imported WatchMonitorModule.  WatchMonitorModule is @Global() so WatchService
// is already visible to ChartinkProcessService without an explicit import here.
// AnandDualTrackModule does NOT import ChartinkModule (relies on global providers)
// so this import is safe (no circular dep).
@Global()
@Module({
  imports: [
    PrismaModule,
    MarketDataModule,
    SignalGeneratorModule,
    UngatedTrackModule,
    AdaptiveStopTrackModule,
    AnandDualTrackModule,
    BreakoutSwingTrackModule,
    SellFuturesModule,
    // Long-running, rate-limited per-stock jobs need a lock LONGER than Bull's
    // 30s default (a job that out-runs the lock is spuriously flagged
    // "stalled" and re-run/failed). Bounded retention (removeOnComplete/Fail)
    // caps the completed+failed sets so the failed-job pileup we just
    // diagnosed (81 stalled jobs) can never grow unbounded again.
    BullModule.registerQueue({
      name: 'chartink-process',
      settings: { lockDuration: 120_000, stalledInterval: 30_000, maxStalledCount: 2 },
      defaultJobOptions: { removeOnComplete: 500, removeOnFail: 500 },
    }),
  ],
  controllers: [ChartinkWebhookController, ChartinkController],
  providers: [
    ChartinkRepository,
    ChartinkIngestService,
    ChartinkProcessService,
    ChartinkScoringService,
    ChartinkRejectionsService,
    ChartinkProcessWorker,
  ],
  exports: [ChartinkRepository, ChartinkScoringService],
})
export class ChartinkModule {}
