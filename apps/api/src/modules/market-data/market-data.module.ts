import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { MarketDataController } from './controllers/market-data.controller';
import { MarketDataGateway } from './gateways/market-data.gateway';
import { MarketFeedService, BROKER_ADAPTER_TOKEN } from './services/market-feed.service';
import { CandleAggregatorService } from './services/candle-aggregator.service';
import { InstrumentService } from './services/instrument.service';
import { MarketDataRepository } from './repositories/market-data.repository';
import { OITrackerProcessor } from './workers/oi-tracker.processor';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'oi-tracker',
    }),
  ],
  controllers: [MarketDataController],
  providers: [
    // Services
    MarketFeedService,
    CandleAggregatorService,
    InstrumentService,

    // Gateway (WebSocket)
    MarketDataGateway,

    // Repository (Prisma data access)
    MarketDataRepository,

    // Bull queue processor
    OITrackerProcessor,

    // Broker adapter placeholder — provide `null` if no adapter is registered.
    // When the AngelOneAdapterService module is imported alongside this module,
    // it should provide a value for BROKER_ADAPTER_TOKEN in the parent module
    // or via a shared providers module.
    {
      provide: BROKER_ADAPTER_TOKEN,
      useValue: null,
    },
  ],
  exports: [
    MarketFeedService,
    CandleAggregatorService,
    InstrumentService,
    MarketDataRepository,
    MarketDataGateway,
  ],
})
export class MarketDataModule {}
