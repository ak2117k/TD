import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { MarketDataController } from './controllers/market-data.controller';
import { MarketDataGateway } from './gateways/market-data.gateway';
import { MarketFeedService, BROKER_ADAPTER_TOKEN } from './services/market-feed.service';
import { CandleAggregatorService } from './services/candle-aggregator.service';
import { InstrumentService } from './services/instrument.service';
import { MarketDataRepository } from './repositories/market-data.repository';
import { OITrackerProcessor } from './workers/oi-tracker.processor';
import { DailyBackfillWorker } from './workers/daily-backfill.worker';
import { AngelOneAuthService } from './services/angel-one-auth.service';
import { AngelOneWebSocketService } from './services/angel-one-websocket.service';
import { AngelOneAdapterService } from './services/angel-one-adapter.service';
import { YahooFinanceService } from './services/yahoo-finance.service';
import { MarketContextService } from './services/market-context.service';
import { OptionsChainModule } from '../options-chain/options-chain.module';
import { SignalGeneratorModule } from '../signal-generator/signal-generator.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'oi-tracker',
    }),
    // forwardRef avoids the circular import: OptionsChainModule imports
    // MarketDataModule (for MarketFeedService) and we now need
    // OptionsChainService here for MarketContextService.
    forwardRef(() => OptionsChainModule),
    // forwardRef avoids the circular import: SignalGeneratorModule imports
    // MarketDataModule (for MarketFeedService) and we need LevelBookService
    // here so MarketFeedService can push ticks into it.
    forwardRef(() => SignalGeneratorModule),
  ],
  controllers: [MarketDataController],
  providers: [
    // Services
    MarketFeedService,
    CandleAggregatorService,
    InstrumentService,
    YahooFinanceService,
    MarketContextService,

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

    // Daily 15:35 IST cron — backfills any candles the live aggregator missed
    // (downtime, restarts, holidays). Together with the one-shot backfill
    // script, keeps the candle table complete without manual intervention.
    DailyBackfillWorker,

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
    YahooFinanceService,
    MarketContextService,
    BROKER_ADAPTER_TOKEN,
  ],
})
export class MarketDataModule {}
