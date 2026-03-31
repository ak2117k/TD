import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { HttpModule } from '@nestjs/axios';
import { MarketDataModule } from '../market-data/market-data.module';
import { SettingsModule } from '../settings/settings.module';
import { SignalGeneratorController } from './controllers/signal-generator.controller';
import { SignalGeneratorService } from './services/signal-generator.service';
import { SignalScoringService } from './services/signal-scoring.service';
import { StrategyRegistryService } from './services/strategy-registry.service';
import { SignalRepository } from './repositories/signal.repository';
import { SignalScanProcessor } from './workers/signal-scan.processor';
import { SignalGateway } from './gateways/signal.gateway';
import { StrategyBuilderController } from './controllers/strategy-builder.controller';
import { StrategyParserService } from './services/strategy-parser.service';
import { StrategyExecutorService } from './services/strategy-executor.service';
import { StrategyStorageService } from './services/strategy-storage.service';
import { RsiReversalStrategy } from './strategies/rsi-reversal.strategy';
import { EmaCrossoverStrategy } from './strategies/ema-crossover.strategy';
import { VwapDeviationStrategy } from './strategies/vwap-deviation.strategy';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'signal-scan' }),
    HttpModule.register({ timeout: 5000 }),
    MarketDataModule,
    SettingsModule,
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

    // User-defined strategy engine
    StrategyParserService,
    StrategyExecutorService,
    StrategyStorageService,

    // Data access
    SignalRepository,

    // Bull queue processor
    SignalScanProcessor,

    // WebSocket gateway
    SignalGateway,
  ],
  exports: [
    SignalGeneratorService,
    SignalScoringService,
    StrategyRegistryService,
    StrategyParserService,
    StrategyExecutorService,
    StrategyStorageService,
    SignalRepository,
  ],
})
export class SignalGeneratorModule {}
