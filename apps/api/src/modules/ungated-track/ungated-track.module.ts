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
import { MarketDataModule } from '../market-data/market-data.module';
import { MarketFeedService } from '../market-data/services/market-feed.service';

@Module({
  imports: [PrismaModule, MarketDataModule],
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
    // Re-subscribe every TRADED ungated entry that was opened in a prior
    // process. Without this, restarting the API drops every existing
    // entry off the feed — currentPrice freezes, loss-cut never triggers,
    // P&L column shows stale data forever. Mirrors the gated
    // WatchService's ensureFeedSubscription pattern.
    await this.watch.resubscribeAllOpenEntries();
  }
}
