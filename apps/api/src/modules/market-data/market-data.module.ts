import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { MarketDataController } from './controllers/market-data.controller';
import { MarketDataGateway } from './gateways/market-data.gateway';
import { MarketFeedService, BROKER_ADAPTER_TOKEN } from './services/market-feed.service';
import { CandleAggregatorService } from './services/candle-aggregator.service';
import { InstrumentService } from './services/instrument.service';
import { MarketDataRepository } from './repositories/market-data.repository';
import { OITrackerProcessor } from './workers/oi-tracker.processor';
import { AngelOneAuthService } from './services/angel-one-auth.service';
import { AngelOneWebSocketService } from './services/angel-one-websocket.service';
import { AngelOneAdapterService } from './services/angel-one-adapter.service';

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

    // Angel One broker services
    AngelOneAuthService,
    AngelOneWebSocketService,
    AngelOneAdapterService,

    // Gateway (WebSocket)
    MarketDataGateway,

    // Repository (Prisma data access)
    MarketDataRepository,

    // Bull queue processor
    OITrackerProcessor,

    // Wire the Angel One adapter as the broker adapter
    {
      provide: BROKER_ADAPTER_TOKEN,
      useExisting: AngelOneAdapterService,
    },
  ],
  exports: [
    MarketFeedService,
    CandleAggregatorService,
    InstrumentService,
    MarketDataRepository,
    MarketDataGateway,
    AngelOneAuthService,
    AngelOneAdapterService,
    BROKER_ADAPTER_TOKEN,
  ],
})
export class MarketDataModule {}
