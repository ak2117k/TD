import { Module } from '@nestjs/common';
import { UngatedWatchRepository } from './repositories/ungated-watch.repository';
import { UngatedTradeRepository } from './repositories/ungated-trade.repository';
import { UngatedRejectionRepository } from './repositories/ungated-rejection.repository';
import { UngatedPaperAccountService } from './services/ungated-paper-account.service';
import { UngatedTradeExecutionService } from './services/ungated-trade-execution.service';
import { UngatedWatchService } from './services/ungated-watch.service';
import { UngatedComparisonService } from './services/ungated-comparison.service';
import { UngatedTrackController } from './controllers/ungated-track.controller';
import { PrismaModule } from '../../common/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [UngatedTrackController],
  providers: [
    UngatedWatchRepository,
    UngatedTradeRepository,
    UngatedRejectionRepository,
    UngatedPaperAccountService,
    UngatedTradeExecutionService,
    UngatedWatchService,
    UngatedComparisonService,
  ],
  exports: [UngatedWatchService, UngatedRejectionRepository],
})
export class UngatedTrackModule {}
