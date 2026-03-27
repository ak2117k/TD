import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { SettingsModule } from '../settings/settings.module';

// Controller
import { TradeEngineController } from './controllers/trade-engine.controller';

// Services
import { TradeExecutionService } from './services/trade-execution.service';
import { PositionManagerService } from './services/position-manager.service';
import { PaperTradeService } from './services/paper-trade.service';
import { RiskManagerService } from './services/risk-manager.service';
import { OrderTrackerService } from './services/order-tracker.service';

// Repository
import { TradeRepository } from './repositories/trade.repository';

// Gateway
import { TradeGateway } from './gateways/trade.gateway';

// Broker adapter token — re-use the same token defined in MarketDataModule.
// The parent AppModule provides the concrete adapter (AngelOneAdapterService).
import { BROKER_ADAPTER_TOKEN } from '../market-data/services/market-feed.service';

@Module({
  imports: [
    PrismaModule,
    MarketDataModule,
    SettingsModule,
  ],
  controllers: [TradeEngineController],
  providers: [
    // Core services
    TradeExecutionService,
    PositionManagerService,
    PaperTradeService,
    RiskManagerService,
    OrderTrackerService,

    // Data access
    TradeRepository,

    // WebSocket gateway
    TradeGateway,

    // Broker adapter — defaults to null if not provided by parent module.
    // The AppModule wires AngelOneAdapterService to this token.
    {
      provide: BROKER_ADAPTER_TOKEN,
      useValue: null,
    },
  ],
  exports: [
    TradeExecutionService,
    PositionManagerService,
    RiskManagerService,
    PaperTradeService,
    OrderTrackerService,
    TradeRepository,
    TradeGateway,
  ],
})
export class TradeEngineModule {}
