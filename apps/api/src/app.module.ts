import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { PrismaModule } from './common/prisma/prisma.module';
import { MarketDataModule } from './modules/market-data/market-data.module';
import { SettingsModule } from './modules/settings/settings.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { SignalGeneratorModule } from './modules/signal-generator/signal-generator.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';
import { TradeEngineModule } from './modules/trade-engine/trade-engine.module';
import { NewsModule } from './modules/news/news.module';
import { BacktestModule } from './modules/backtest/backtest.module';
import { OptionsChainModule } from './modules/options-chain/options-chain.module';
import { AIAdvisorModule } from './modules/ai-advisor/ai-advisor.module';
import { AutoTradeModule } from './modules/auto-trade/auto-trade.module';
import { InsightsModule } from './modules/insights/insights.module';
import { BrokerModule } from './modules/broker/broker.module';
import { ChartinkModule } from './modules/chartink/chartink.module';
import { FundamentalsModule } from './modules/fundamentals/fundamentals.module';
import { WatchMonitorModule } from './modules/watch-monitor/watch-monitor.module';

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

    // AI Insights — section-level Claude analysis via MCP
    InsightsModule,

    // Auto-trade — signal-to-trade automation with approval workflow
    AutoTradeModule,

    // Broker management — credential storage and connection lifecycle
    BrokerModule,

    // Chartink — webhook-driven scanner alerts feeding the setup pipeline
    ChartinkModule,

    // Fundamentals — Yahoo Finance-sourced stock fundamentals (24h cache)
    FundamentalsModule,

    // Watch Monitor — Stage 2 trade watch lifecycle, scoring, options selection
    WatchMonitorModule,
  ],
  providers: [],
})
export class AppModule {}
