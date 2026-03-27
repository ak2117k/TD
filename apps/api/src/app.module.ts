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
import { SignalGeneratorModule } from './modules/signal-generator/signal-generator.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';
import { TradeEngineModule } from './modules/trade-engine/trade-engine.module';
import { NewsModule } from './modules/news/news.module';
import { BacktestModule } from './modules/backtest/backtest.module';
import { OptionsChainModule } from './modules/options-chain/options-chain.module';
import { AIAdvisorModule } from './modules/ai-advisor/ai-advisor.module';

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

    // Signal generation — strategy scanning, scoring, WebSocket broadcast
    SignalGeneratorModule,

    // Portfolio tracking & performance analytics
    PortfolioModule,

    // Trade engine — order execution, position tracking, risk management
    TradeEngineModule,

    // News aggregation with AI sentiment analysis
    NewsModule,

    // Backtesting — strategy backtest engine
    BacktestModule,

    // Options chain — live Greeks, IV, OI analysis
    OptionsChainModule,

    // AI-powered trading advisor — insights, chat, weekly reports
    AIAdvisorModule,

    // Feature modules (upcoming stages)
    // AutoTradeModule,
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
