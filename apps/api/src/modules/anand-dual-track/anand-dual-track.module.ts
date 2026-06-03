import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { ChartinkModule } from '../chartink/chartink.module';
import { AnandDualTrackRepository } from './repositories/anand-dual-track.repository';
import { AnandDualTrackService } from './services/anand-dual-track.service';
import { AnandPriceMonitorService } from './services/anand-price-monitor.service';
import { AnandDualTrackController } from './controllers/anand-dual-track.controller';

@Module({
  imports: [PrismaModule, MarketDataModule, ChartinkModule],
  controllers: [AnandDualTrackController],
  providers: [AnandDualTrackRepository, AnandDualTrackService, AnandPriceMonitorService],
  exports: [AnandDualTrackService],
})
export class AnandDualTrackModule {}
