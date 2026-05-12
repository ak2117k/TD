import { Injectable, Logger } from '@nestjs/common';
import { ChartinkRepository } from '../repositories/chartink.repository';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { SignalGeneratorService } from '../../signal-generator/services/signal-generator.service';
import { SetupTrackerService } from '../../signal-generator/services/setup-tracker.service';
import { MtfAlignmentService } from '../../signal-generator/services/mtf-alignment.service';

interface Hit {
  symbol: string;
  hitPrice: number;
}

const RATE_LIMIT_MS = 350;

@Injectable()
export class ChartinkProcessService {
  private readonly logger = new Logger(ChartinkProcessService.name);

  constructor(
    private readonly repo: ChartinkRepository,
    private readonly mdRepo: MarketDataRepository,
    private readonly signalSvc: SignalGeneratorService,
    private readonly tracker: SetupTrackerService,
    private readonly mtf: MtfAlignmentService,
  ) {}

  async processAlert(alertId: string, hits: Hit[]): Promise<void> {
    this.logger.log(`Processing Chartink alert ${alertId} — ${hits.length} hits`);
    for (let i = 0; i < hits.length; i++) {
      try {
        await this.processOne(alertId, hits[i]);
      } catch (err) {
        this.logger.warn(
          `processOne unexpected throw for ${hits[i].symbol}: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (i < hits.length - 1) await this.sleep(RATE_LIMIT_MS);
    }
  }

  async processOne(alertId: string, hit: Hit): Promise<void> {
    // Chartink sends bare symbols ("LLOYDSENGG"), but our local Instrument
    // table stores them with the NSE series suffix ("LLOYDSENGG-EQ" for
    // regular equity, "-BE" for trade-to-trade — common on micro-caps
    // and recently-listed stocks). Try bare, then -EQ (canonical liquid
    // equity), then -BE (trade-to-trade). Covers ~99% of NSE cash
    // instruments. If still nothing, mark unresolved.
    let instrument = await this.mdRepo.getInstrumentBySymbol(hit.symbol, 'NSE');
    if (!instrument) {
      instrument = await this.mdRepo.getInstrumentBySymbol(`${hit.symbol}-EQ`, 'NSE');
    }
    if (!instrument) {
      instrument = await this.mdRepo.getInstrumentBySymbol(`${hit.symbol}-BE`, 'NSE');
    }
    if (!instrument) {
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: null,
        hitPrice: hit.hitPrice,
        kind: 'unresolved',
        setupId: null,
        rejectReason: 'symbol not in local DB (tried bare, -EQ, -BE)',
      });
      return;
    }

    // MTF gate — 4-TF directional agreement check before any deeper analysis.
    // On misalignment we persist immediately and skip analyze() to save
    // additional broker calls per hit.
    const mtf = await this.mtf.check(instrument.token, 'NSE');
    if (!mtf.aligned) {
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'mtf-misaligned',
        setupId: null,
        rejectReason: `TF: ${mtf.summary}`,
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
