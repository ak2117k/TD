import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { StrategyRegistryService } from '../../signal-generator/services/strategy-registry.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { BacktestRepository } from '../repositories/backtest.repository';
import { RunBacktestDto } from '../dto/backtest.dto';
import type {
  BacktestResult,
  CandleData,
} from '../../../common/interfaces/trading-strategy.interface';

export interface ComparisonResult {
  configs: RunBacktestDto[];
  results: Array<BacktestResult & { strategy: string }>;
}

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);

  constructor(
    private readonly strategyRegistry: StrategyRegistryService,
    private readonly marketDataRepo: MarketDataRepository,
    private readonly backtestRepo: BacktestRepository,
  ) {}

  /**
   * Run a single backtest for a given configuration.
   */
  async runBacktest(config: RunBacktestDto): Promise<BacktestResult> {
    // 1. Get strategy from registry
    const strategy = this.strategyRegistry.getStrategy(config.strategy);
    if (!strategy) {
      throw new NotFoundException(
        `Strategy "${config.strategy}" not found in registry`,
      );
    }

    // 2. Find the instrument to get instrumentId
    const instruments = await this.marketDataRepo.searchInstruments(
      config.symbol,
      config.exchange,
    );

    if (instruments.length === 0) {
      throw new NotFoundException(
        `Instrument "${config.symbol}" not found on ${config.exchange}`,
      );
    }

    const instrument = instruments[0];

    // 3. Fetch historical candles for the date range
    const rawCandles = await this.marketDataRepo.getCandles(
      instrument.id,
      config.timeframe,
      config.startDate,
      config.endDate,
    );

    if (rawCandles.length === 0) {
      throw new BadRequestException(
        `No candle data available for ${config.symbol} (${config.timeframe}) between ${config.startDate.toISOString()} and ${config.endDate.toISOString()}`,
      );
    }

    // Convert DB candles to CandleData interface
    const candles: CandleData[] = rawCandles.map((c) => ({
      timestamp: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: Number(c.volume),
    }));

    this.logger.log(
      `Running backtest: ${config.strategy} on ${config.symbol} (${candles.length} candles)`,
    );

    // 4. Run the strategy backtest
    const result = strategy.backtest({
      candles,
      initialCapital: config.initialCapital,
      positionSize: config.positionSize,
    });

    // 5. Save to DB
    await this.backtestRepo.saveBacktestRun({
      strategy: config.strategy,
      parameters: {
        symbol: config.symbol,
        exchange: config.exchange,
        timeframe: config.timeframe,
        initialCapital: config.initialCapital,
        positionSize: config.positionSize,
      },
      startDate: config.startDate,
      endDate: config.endDate,
      totalTrades: result.totalTrades,
      winRate: result.winRate,
      totalReturn: result.totalReturn,
      maxDrawdown: result.maxDrawdown,
      sharpeRatio: result.sharpeRatio,
      results: result,
    });

    this.logger.log(
      `Backtest complete: ${result.totalTrades} trades, ${result.winRate.toFixed(1)}% win rate, ${result.totalReturnPercent.toFixed(2)}% return`,
    );

    return result;
  }

  /**
   * Compare multiple strategies side by side.
   */
  async compareStrategies(
    configs: RunBacktestDto[],
  ): Promise<ComparisonResult> {
    if (configs.length < 2 || configs.length > 5) {
      throw new BadRequestException(
        'Comparison requires between 2 and 5 strategy configurations',
      );
    }

    const results = await Promise.all(
      configs.map(async (config) => {
        const result = await this.runBacktest(config);
        return { ...result, strategy: config.strategy };
      }),
    );

    return { configs, results };
  }

  /**
   * Get history of past backtest runs.
   */
  async getBacktestHistory(limit = 20, offset = 0) {
    return this.backtestRepo.getBacktestRuns(limit, offset);
  }

  /**
   * Get a single backtest run by ID.
   */
  async getBacktestById(id: string) {
    const run = await this.backtestRepo.getBacktestById(id);
    if (!run) {
      throw new NotFoundException(`Backtest run "${id}" not found`);
    }
    return run;
  }

  /**
   * Delete a backtest run.
   */
  async deleteBacktest(id: string) {
    const existing = await this.backtestRepo.getBacktestById(id);
    if (!existing) {
      throw new NotFoundException(`Backtest run "${id}" not found`);
    }
    await this.backtestRepo.deleteBacktest(id);
    return { success: true };
  }
}
