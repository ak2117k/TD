import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { PrismaModule } from './common/prisma/prisma.module';
import { MarketDataModule } from './modules/market-data/market-data.module';
import { AngelOneAdapterService } from './modules/market-data/services/angel-one-adapter.service';
import { AngelOneAuthService } from './modules/market-data/services/angel-one-auth.service';
import { AngelOneWebSocketService } from './modules/market-data/services/angel-one-websocket.service';
import { BROKER_ADAPTER_TOKEN } from './modules/market-data/services/market-feed.service';
import { SettingsModule } from './modules/settings/settings.module';
import { AlertsModule } from './modules/alerts/alerts.module';

@Module({
  imports: [
    // Global configuration from .env
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),

    // Bull queue with Redis backend
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        redis: {
          host: config.get<string>('redis.host'),
          port: config.get<number>('redis.port'),
          password: config.get<string>('redis.password') || undefined,
        },
      }),
    }),

    // Cron / interval scheduling
    ScheduleModule.forRoot(),

    // Database
    PrismaModule,

    // Market data — live feeds, candles, OI, instruments
    MarketDataModule,

    // Settings & Alerts
    SettingsModule,
    AlertsModule,

    // Feature modules (upcoming stages)
    // TradeEngineModule,
    // SignalGeneratorModule,
    // AutoTradeModule,
    // PortfolioModule,
    // NewsModule,
    // AIAdvisorModule,
    // BacktestModule,
    // OptionsChainModule,
  ],
  providers: [
    // Angel One broker services
    AngelOneAuthService,
    AngelOneWebSocketService,
    AngelOneAdapterService,

    // Wire Angel One adapter as the broker adapter for MarketFeedService
    {
      provide: BROKER_ADAPTER_TOKEN,
      useExisting: AngelOneAdapterService,
    },
  ],
})
export class AppModule {}
