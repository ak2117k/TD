import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { OptionsChainController } from './controllers/options-chain.controller';
import { OptionsChainService } from './services/options-chain.service';
import { GreeksCalculatorService } from './services/greeks-calculator.service';
import { BROKER_ADAPTER_TOKEN } from '../market-data/services/market-feed.service';

@Module({
  imports: [PrismaModule, MarketDataModule],
  controllers: [OptionsChainController],
  providers: [
    OptionsChainService,
    GreeksCalculatorService,
    // Default null broker adapter — overridden by the parent AppModule provider
    {
      provide: BROKER_ADAPTER_TOKEN,
      useValue: null,
    },
  ],
  exports: [OptionsChainService, GreeksCalculatorService],
})
export class OptionsChainModule {}
