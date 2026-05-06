import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { SignalGeneratorService } from '../services/signal-generator.service';
import { StrategyRegistryService } from '../services/strategy-registry.service';
import { SignalRepository } from '../repositories/signal.repository';
import { UniverseScannerWorker } from '../workers/universe-scanner.worker';
import { SetupTrackerService } from '../services/setup-tracker.service';
import { SignalFilterDto } from '../dto/signal.dto';
import { ChartinkRepository } from '../../chartink/repositories/chartink.repository';

@Controller('api/signals')
export class SignalGeneratorController {
  private readonly logger = new Logger(SignalGeneratorController.name);

  constructor(
    private readonly signalGeneratorService: SignalGeneratorService,
    private readonly strategyRegistry: StrategyRegistryService,
    private readonly signalRepository: SignalRepository,
    private readonly universeScannerWorker: UniverseScannerWorker,
    private readonly setupTracker: SetupTrackerService,
    @InjectQueue('signal-scan') private readonly signalScanQueue: Queue,
    // Optional so unit tests / non-Chartink wirings still construct cleanly.
    // When wired (in app boot) every signal listing gets a chartinkSource
    // field — null unless a Chartink alert produced the matching setup.
    @Optional() private readonly chartinkRepo?: ChartinkRepository,
  ) {}

  /**
   * Enrich a signal with its `chartinkSource` if any. Looks up the
   * ChartinkAlertSetup row that points back at this signal — when no
   * Chartink alert produced this signal, returns null. Repo is optional
   * so this gracefully no-ops in test wirings.
   */
  private async enrichWithChartinkSource(signal: any): Promise<any> {
    if (!signal || typeof signal !== 'object') return signal;
    const chartinkSource = this.chartinkRepo
      ? await this.chartinkRepo.findChartinkSourceForSetup(signal.id)
      : null;
    return { ...signal, chartinkSource };
  }

  /**
   * GET /api/signals/setups/active — currently locked setup for a token.
   */
  @Get('setups/active')
  getActiveSetup(@Query('token') token: string) {
    if (!token) {
      throw new BadRequestException('token is required');
    }
    return { setup: this.setupTracker.getActive(token) };
  }

  /**
   * GET /api/signals/setups/history — recent closed setups for a token.
   */
  @Get('setups/history')
  getSetupHistory(@Query('token') token: string) {
    if (!token) {
      throw new BadRequestException('token is required');
    }
    return { history: this.setupTracker.getHistory(token) };
  }

  /**
   * POST /api/signals/scan-now — manually trigger one universe scan tick.
   * Bypasses the 15-min cron so we can smoke-test the combined-strategy
   * pipeline immediately. Returns the per-symbol outcome.
   */
  @Post('scan-now')
  @HttpCode(HttpStatus.OK)
  async scanNow() {
    return this.universeScannerWorker.runOnce();
  }

  /**
   * POST /api/signals/reset-transition — clear the combined strategy's
   * transition memory so it can re-fire even if the conditions are still
   * aligned. Use this to unstick the strategy after a downstream failure
   * left it thinking a trade was already placed when it wasn't.
   */
  @Post('reset-transition')
  @HttpCode(HttpStatus.OK)
  async resetTransition() {
    const strat = this.strategyRegistry.getStrategy('anand-sniper-v25-combined') as
      | { resetTransition?: () => void }
      | undefined;
    if (strat && typeof strat.resetTransition === 'function') {
      strat.resetTransition();
      return { ok: true, reset: 'anand-sniper-v25-combined' };
    }
    return { ok: false, reason: 'strategy not found or does not support reset' };
  }

  /**
   * GET /api/signals — list signals with filters and pagination.
   */
  @Get()
  async listSignals(@Query() filters: SignalFilterDto) {
    const result = await this.signalGeneratorService.getSignalHistory(filters);
    return {
      ...result,
      data: Array.isArray(result.data)
        ? await Promise.all(result.data.map((s) => this.enrichWithChartinkSource(s)))
        : result.data,
    };
  }

  /**
   * GET /api/signals/active — currently active signals.
   *
   * `?recentHours=N` also returns signals that expired within the last
   * N hours. The Signals page uses N=12 so traders can see the day's
   * earlier signals after their session-end TTL has flipped them to
   * inactive.
   */
  @Get('active')
  async getActiveSignals(@Query('recentHours') recentHours?: string) {
    const hours = recentHours ? Number(recentHours) : 0;
    const signals = await this.signalGeneratorService.getActiveSignals(
      Number.isFinite(hours) && hours > 0 ? hours : 0,
    );
    return Array.isArray(signals)
      ? Promise.all(signals.map((s) => this.enrichWithChartinkSource(s)))
      : signals;
  }

  /**
   * GET /api/signals/strategies — list all registered strategies with metadata.
   */
  @Get('strategies')
  async listStrategies() {
    return this.strategyRegistry.getAllStrategies();
  }

  @Get('analyze')
  async analyzeChart(
    @Query('token') token: string,
    @Query('exchange') exchange: string,
    @Query('symbol') symbol: string,
    @Query('timeframe') timeframe?: string,
  ) {
    if (!token || !exchange || !symbol) {
      throw new BadRequestException('token, exchange, symbol are required');
    }
    try {
      return await this.signalGeneratorService.analyze(
        token,
        exchange,
        symbol,
        timeframe ?? '15m',
      );
    } catch (err) {
      this.logger.error(
        `analyze failed for ${symbol}/${timeframe ?? '15m'}: ${err instanceof Error ? err.stack ?? err.message : err}`,
      );
      throw err;
    }
  }

  /**
   * GET /api/signals/strategies/:name/performance — strategy performance stats.
   */
  @Get('strategies/:name/performance')
  async getStrategyPerformance(
    @Param('name') name: string,
    @Query('days') days?: string,
  ) {
    const lookbackDays = days ? parseInt(days, 10) : 30;
    const fromDate = new Date(
      Date.now() - lookbackDays * 24 * 60 * 60 * 1000,
    );
    return this.signalRepository.getStrategyPerformance(name, fromDate);
  }

  /**
   * GET /api/signals/:id — single signal detail.
   */
  @Get(':id')
  async getSignalById(@Param('id') id: string) {
    const signal = await this.signalRepository.getSignalById(id);
    if (!signal) {
      throw new NotFoundException(`Signal ${id} not found`);
    }
    return this.enrichWithChartinkSource(signal);
  }

  /**
   * POST /api/signals/scan — trigger a manual scan (for testing/admin).
   */
  @Post('scan')
  @HttpCode(HttpStatus.ACCEPTED)
  async triggerScan() {
    this.logger.log('Manual signal scan triggered');

    await this.signalScanQueue.add(
      { scanAll: true },
      {
        removeOnComplete: true,
        removeOnFail: 10,
        attempts: 1,
      },
    );

    return { message: 'Signal scan queued', status: 'accepted' };
  }

  /**
   * DELETE /api/signals/:id — deactivate a signal.
   */
  @Delete(':id')
  async deactivateSignal(@Param('id') id: string) {
    const signal = await this.signalRepository.getSignalById(id);
    if (!signal) {
      throw new NotFoundException(`Signal ${id} not found`);
    }

    return this.signalGeneratorService.deactivateSignal(id);
  }
}
