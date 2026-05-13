import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { SignalGeneratorModule } from '../signal-generator/signal-generator.module';
import { ChartinkRepository } from './repositories/chartink.repository';
import { ChartinkIngestService } from './services/chartink-ingest.service';
import { ChartinkProcessService } from './services/chartink-process.service';
import { ChartinkScoringService } from './services/chartink-scoring.service';
import { ChartinkProcessWorker } from './workers/chartink-process.worker';
import { ChartinkWebhookController } from './controllers/chartink-webhook.controller';
import { ChartinkController } from './controllers/chartink.controller';

// @Global so ChartinkRepository and ChartinkScoringService are injectable
// without consumers importing this module — avoids the circular dep that would
// form if WatchMonitorModule imported ChartinkModule AND ChartinkModule
// imported WatchMonitorModule.  WatchMonitorModule is @Global() so WatchService
// is already visible to ChartinkProcessService without an explicit import here.
@Global()
@Module({
  imports: [
    PrismaModule,
    MarketDataModule,
    SignalGeneratorModule,
    BullModule.registerQueue({ name: 'chartink-process' }),
  ],
  controllers: [ChartinkWebhookController, ChartinkController],
  providers: [
    ChartinkRepository,
    ChartinkIngestService,
    ChartinkProcessService,
    ChartinkScoringService,
    ChartinkProcessWorker,
  ],
  exports: [ChartinkRepository, ChartinkScoringService],
})
export class ChartinkModule {}
