import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { SignalGeneratorModule } from '../signal-generator/signal-generator.module';
import { ChartinkRepository } from './repositories/chartink.repository';
import { ChartinkIngestService } from './services/chartink-ingest.service';
import { ChartinkProcessService } from './services/chartink-process.service';
import { ChartinkProcessWorker } from './workers/chartink-process.worker';
import { ChartinkWebhookController } from './controllers/chartink-webhook.controller';
import { ChartinkController } from './controllers/chartink.controller';

// @Global so ChartinkRepository is injectable into SignalGeneratorController
// (in SignalGeneratorModule) without that module needing to import this one —
// which would be a cycle since ChartinkModule already imports SignalGeneratorModule.
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
    ChartinkProcessWorker,
  ],
  exports: [ChartinkRepository],
})
export class ChartinkModule {}
