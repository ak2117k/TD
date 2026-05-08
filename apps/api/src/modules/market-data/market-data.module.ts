import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { HttpModule } from '@nestjs/axios';
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
import { CommodityRollService } from './services/commodity-roll.service';
import { CommodityRollCron } from './services/commodity-roll.cron';
import { OptionsChainModule } from '../options-chain/options-chain.module';
// LevelBookService comes from SignalGeneratorModule which is @Global —
// no import needed here. Importing the module would create a bootstrap
// cycle because SignalGeneratorModule already imports MarketDataModule.

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'oi-tracker',
    }),
    // ScripMaster fetch (~30MB JSON) for the commodity-roll service.
    // 60s timeout — Angel's CDN sometimes takes 20-30s for the full file.
    HttpModule.register({ timeout: 60_000, maxContentLength: 100 * 1024 * 1024 }),
    // forwardRef avoids the circular import: OptionsChainModule imports
    // MarketDataModule (for MarketFeedService) and we now need
    // OptionsChainService here for MarketContextService.
    forwardRef(() => OptionsChainModule),
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

    // Daily 08:30 IST cron — detects MCX commodity FUTCOM contract
    // expiry and rolls the instrument row's token to the new front-month
    // automatically. Replaces the manual roll-mcx-front-month.mjs script.
    CommodityRollService,
    CommodityRollCron,

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
