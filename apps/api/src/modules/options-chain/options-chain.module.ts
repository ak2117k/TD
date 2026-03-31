import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { OptionsChainController } from './controllers/options-chain.controller';
import { OptionsChainService } from './services/options-chain.service';
import { GreeksCalculatorService } from './services/greeks-calculator.service';

@Module({
  imports: [PrismaModule, MarketDataModule],
  controllers: [OptionsChainController],
  providers: [
    OptionsChainService,
    GreeksCalculatorService,
    // BROKER_ADAPTER_TOKEN is exported by MarketDataModule and available
    // via injection — no need to re-provide it here.
  ],
  exports: [OptionsChainService, GreeksCalculatorService],
})
export class OptionsChainModule {}
