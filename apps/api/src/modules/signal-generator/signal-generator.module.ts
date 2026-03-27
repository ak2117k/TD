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

@Module({
  imports: [
    BullModule.registerQueue({ name: 'signal-scan' }),
    HttpModule.register({ timeout: 5000 }),
    MarketDataModule,
    SettingsModule,
  ],
  controllers: [SignalGeneratorController],
  providers: [
    // Core services
    SignalGeneratorService,
    SignalScoringService,
    StrategyRegistryService,

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
    SignalRepository,
  ],
})
export class SignalGeneratorModule {}
