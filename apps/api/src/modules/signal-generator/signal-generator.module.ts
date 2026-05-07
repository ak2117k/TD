import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { HttpModule } from '@nestjs/axios';
import { MarketDataModule } from '../market-data/market-data.module';
import { SettingsModule } from '../settings/settings.module';
import { OptionsChainModule } from '../options-chain/options-chain.module';
import { TradeEngineModule } from '../trade-engine/trade-engine.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { SignalGeneratorController } from './controllers/signal-generator.controller';
import { SignalGeneratorService } from './services/signal-generator.service';
import { SignalScoringService } from './services/signal-scoring.service';
import { StrategyRegistryService } from './services/strategy-registry.service';
import { SignalRepository } from './repositories/signal.repository';
import { SignalScanProcessor } from './workers/signal-scan.processor';
import { UniverseScannerWorker } from './workers/universe-scanner.worker';
import { SignalGateway } from './gateways/signal.gateway';
import { StrategyBuilderController } from './controllers/strategy-builder.controller';
import { StrategyParserService } from './services/strategy-parser.service';
import { StrategyExecutorService } from './services/strategy-executor.service';
import { StrategyStorageService } from './services/strategy-storage.service';
import { RsiReversalStrategy } from './strategies/rsi-reversal.strategy';
import { EmaCrossoverStrategy } from './strategies/ema-crossover.strategy';
import { VwapDeviationStrategy } from './strategies/vwap-deviation.strategy';
import { AnandSniperV25CombinedStrategy } from './strategies/anand-sniper-v25-combined.strategy';
import { LevelBookService } from './services/level-book.service';
import { LevelBookCron } from './services/level-book.cron';
import { SetupTrackerService } from './services/setup-tracker.service';
import { ZoneRepository } from './repositories/zone.repository';
import { StrongZoneDetectorService } from './services/strong-zone-detector.service';

// @Global so LevelBookService is injectable from MarketFeedService
// (in MarketDataModule) without MarketDataModule needing to import this
// module — that would be a bootstrap cycle since SignalGeneratorModule
// already imports MarketDataModule.
@Global()
@Module({
  imports: [
    BullModule.registerQueue({ name: 'signal-scan' }),
    BullModule.registerQueue({ name: 'signal-review' }),
    HttpModule.register({ timeout: 5000 }),
    PrismaModule,
    MarketDataModule,
    SettingsModule,
    OptionsChainModule,
    TradeEngineModule,
  ],
  controllers: [SignalGeneratorController, StrategyBuilderController],
  providers: [
    // Core services
    SignalGeneratorService,
    SignalScoringService,
    StrategyRegistryService,

    // Built-in trading strategies
    RsiReversalStrategy,
    EmaCrossoverStrategy,
    VwapDeviationStrategy,
    AnandSniperV25CombinedStrategy,

    // User-defined strategy engine
    StrategyParserService,
    StrategyExecutorService,
    StrategyStorageService,

    // Data access
    SignalRepository,

    // Bull queue processor
    SignalScanProcessor,

    // Universe scanner — auto-trades NIFTY+BANKNIFTY on the combined rule
    UniverseScannerWorker,

    // WebSocket gateway
    SignalGateway,

    // Level book — per-instrument VWAP / today H/L / spot tracker
    LevelBookService,

    // Cron jobs — pre-market session seeder (09:15) + opening range locker (09:30)
    LevelBookCron,

    // In-memory locked-setup tracker — anchors entry/SL/target so the same
    // setup re-evaluated on subsequent polls returns the same numbers.
    SetupTrackerService,

    // Strong-zone persistence cache. Used by SignalGeneratorService to feed
    // the TP1-at-obstacle algorithm with the active S/R zone set per token.
    ZoneRepository,

    // Strong/swap zone detector — pure compute, fed by /signals/zones
    // on cache miss so the chart overlay never sees an empty zone list.
    StrongZoneDetectorService,
  ],
  exports: [
    SignalGeneratorService,
    SignalScoringService,
    StrategyRegistryService,
    StrategyParserService,
    StrategyExecutorService,
    StrategyStorageService,
    SignalRepository,
    LevelBookService,
    SetupTrackerService,
  ],
})
export class SignalGeneratorModule {}
