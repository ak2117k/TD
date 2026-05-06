import { Injectable, Logger } from '@nestjs/common';
import { ChartinkRepository } from '../repositories/chartink.repository';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { SignalGeneratorService } from '../../signal-generator/services/signal-generator.service';
import { SetupTrackerService } from '../../signal-generator/services/setup-tracker.service';

interface Hit {
  symbol: string;
  hitPrice: number;
}

const RATE_LIMIT_MS = 350; // matches Angel One historical-API serial pacer (per memory)

@Injectable()
export class ChartinkProcessService {
  private readonly logger = new Logger(ChartinkProcessService.name);

  constructor(
    private readonly repo: ChartinkRepository,
    private readonly mdRepo: MarketDataRepository,
    private readonly signalSvc: SignalGeneratorService,
    private readonly tracker: SetupTrackerService,
  ) {}

  /**
   * Process every hit in an alert sequentially, with rate-limit pacing
   * between symbols (broker historical API caps at ~3 req/s).
   */
  async processAlert(alertId: string, hits: Hit[]): Promise<void> {
    this.logger.log(`Processing Chartink alert ${alertId} — ${hits.length} hits`);
    for (let i = 0; i < hits.length; i++) {
      try {
        await this.processOne(alertId, hits[i]);
      } catch (err) {
        // Per-symbol failures already get a 'error' AlertSetup row in processOne;
        // this catch is the absolute belt-and-braces for unexpected throws.
        this.logger.warn(
          `processOne unexpected throw for ${hits[i].symbol}: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (i < hits.length - 1) await this.sleep(RATE_LIMIT_MS);
    }
  }

  /**
   * One symbol → one ChartinkAlertSetup row. Branches on whether the
   * symbol resolves, whether analyze() returns a setup, no-setup, or throws.
   */
  async processOne(alertId: string, hit: Hit): Promise<void> {
    const instrument = await this.mdRepo.getInstrumentBySymbol(hit.symbol, 'NSE');
    if (!instrument) {
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: null,
        hitPrice: hit.hitPrice,
        kind: 'unresolved',
        setupId: null,
        rejectReason: 'symbol not in local DB',
      });
      return;
    }

    let result: { kind: string; reason?: string };
    try {
      result = (await this.signalSvc.analyze(
        instrument.token, 'NSE', hit.symbol, '15m',
      )) as { kind: string; reason?: string };
    } catch (err) {
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'error',
        setupId: null,
        rejectReason: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (result.kind === 'setup') {
      const locked = this.tracker.getActive(instrument.token);
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'setup',
        setupId: locked?.id ?? null,
        rejectReason: null,
      });
    } else {
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'no-setup',
        setupId: null,
        rejectReason: result.reason ?? null,
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
