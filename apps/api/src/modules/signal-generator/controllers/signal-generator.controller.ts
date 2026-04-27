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
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { SignalGeneratorService } from '../services/signal-generator.service';
import { StrategyRegistryService } from '../services/strategy-registry.service';
import { SignalRepository } from '../repositories/signal.repository';
import { UniverseScannerWorker } from '../workers/universe-scanner.worker';
import { SignalFilterDto } from '../dto/signal.dto';

@Controller('api/signals')
export class SignalGeneratorController {
  private readonly logger = new Logger(SignalGeneratorController.name);

  constructor(
    private readonly signalGeneratorService: SignalGeneratorService,
    private readonly strategyRegistry: StrategyRegistryService,
    private readonly signalRepository: SignalRepository,
    private readonly universeScannerWorker: UniverseScannerWorker,
    @InjectQueue('signal-scan') private readonly signalScanQueue: Queue,
  ) {}

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
    return this.signalGeneratorService.getSignalHistory(filters);
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
    return this.signalGeneratorService.getActiveSignals(
      Number.isFinite(hours) && hours > 0 ? hours : 0,
    );
  }

  /**
   * GET /api/signals/strategies — list all registered strategies with metadata.
   */
  @Get('strategies')
  async listStrategies() {
    return this.strategyRegistry.getAllStrategies();
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
    return signal;
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
