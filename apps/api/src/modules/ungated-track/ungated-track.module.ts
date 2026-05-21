import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { UngatedWatchRepository } from './repositories/ungated-watch.repository';
import { UngatedTradeRepository } from './repositories/ungated-trade.repository';
import { UngatedRejectionRepository } from './repositories/ungated-rejection.repository';
import { UngatedPaperAccountService } from './services/ungated-paper-account.service';
import { UngatedTradeExecutionService } from './services/ungated-trade-execution.service';
import { UngatedWatchService } from './services/ungated-watch.service';
import { UngatedComparisonService } from './services/ungated-comparison.service';
import { UngatedTrackController } from './controllers/ungated-track.controller';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketFeedService } from '../market-data/services/market-feed.service';

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
export class UngatedTrackModule implements OnApplicationBootstrap {
  constructor(
    private readonly watch: UngatedWatchService,
    private readonly feed: MarketFeedService,
  ) {}

  // Register a SECOND tick handler on the market feed (additional to the
  // gated WatchMonitorModule handler). Each tick fans out to both tracks
  // for any token that has a subscription.
  async onApplicationBootstrap() {
    this.feed.registerWatchTickHandler(async (token, ltp, ts) => {
      await this.watch.onTick(token, ltp, ts);
    });
  }
}
