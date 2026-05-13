import { Injectable, Logger } from '@nestjs/common';
import { ChartinkRepository } from '../repositories/chartink.repository';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { SignalGeneratorService } from '../../signal-generator/services/signal-generator.service';
import { SetupTrackerService } from '../../signal-generator/services/setup-tracker.service';
import { MtfAlignmentService } from '../../signal-generator/services/mtf-alignment.service';
import { ChartinkScoringService, type SetupSide } from './chartink-scoring.service';
import { WatchService, WatchCapExceededError } from '../../watch-monitor/services/watch.service';

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
    private readonly scoring: ChartinkScoringService,
    private readonly watch: WatchService,
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
    // Chartink sends bare symbols ("LLOYDSENGG"). Our local Instrument
    // table stores them with the NSE series suffix:
    //   -EQ  regular liquid equity (vast majority of liquid stocks)
    //   -BE  trade-to-trade (low-liquidity / surveillance)
    //   -BL  block deal series (sometimes used for ETF tranches)
    //   -IV  insurance / other special series
    // Try bare first (defensive), then each suffix.
    const SUFFIXES = ['', '-EQ', '-BE', '-BL', '-IV'];
    let instrument = null as Awaited<ReturnType<typeof this.mdRepo.getInstrumentBySymbol>>;
    for (const suffix of SUFFIXES) {
      const lookup = suffix ? `${hit.symbol}${suffix}` : hit.symbol;
      instrument = await this.mdRepo.getInstrumentBySymbol(lookup, 'NSE');
      if (instrument) break;
    }
    if (!instrument) {
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: null,
        hitPrice: hit.hitPrice,
        kind: 'unresolved',
        setupId: null,
        rejectReason: `symbol not in local DB (tried ${SUFFIXES.map(s => s || 'bare').join(', ')})`,
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
      // Run 9-check scoring on the locked setup. Guard against throws so a
      // scoring failure never blocks the underlying setup persistence — fall
      // back to null score/lotCount in that case.
      let scoring = null as Awaited<ReturnType<typeof this.scoring.score>> | null;
      if (locked) {
        try {
          scoring = await this.scoring.score({
            token: instrument.token,
            symbol: hit.symbol,
            exchange: 'NSE',
            side: (locked.entry > locked.stoploss ? 'BUY' : 'SELL') as SetupSide,
            entryPrice: locked.entry,
            // LockedSetup may carry a levelBookSnapshot at runtime (set by the
            // strategy when the setup is locked); the type doesn't expose it
            // yet so we cast defensively. If absent at runtime the S/R-room
            // check returns "no level book" → 0 points without throwing.
            setupContext: locked as unknown as {
              levelBookSnapshot?: {
                pdh: number;
                pdl: number;
                orh: number | null;
                orl: number | null;
                vwap: number;
              };
            },
          });
        } catch (err) {
          this.logger.warn(
            `scoring failed for ${hit.symbol}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      const persistedSetup = await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'setup',
        setupId: locked?.id ?? null,
        rejectReason: null,
        score: scoring?.score ?? null,
        lotCount: scoring?.lotCount ?? null,
        scoreBreakdown: scoring?.checks ?? null,
      });

      // Wire to watch monitor (Stage 2) — only when score passes the lot band
      // gate (≥ 50). Failures here MUST NOT block setup persistence.
      if (scoring && scoring.score >= 50 && locked) {
        try {
          await this.watch.createFromAlert({
            alertId,
            setupId: persistedSetup.id,
            symbol: hit.symbol,
            token: instrument.token,
            exchange: 'NSE',
            side: (locked.entry > locked.stoploss ? 'BUY' : 'SELL'),
            initialPrice: locked.entry,
            initialScore: scoring.score,
            initialBreakdown: { checks: scoring.checks, lotCount: scoring.lotCount } as unknown as import('@prisma/client').Prisma.InputJsonValue,
          });
        } catch (err) {
          if (err instanceof WatchCapExceededError) {
            this.logger.warn(`watch cap exceeded — skipping ${hit.symbol}`);
          } else {
            this.logger.warn(
              `watch.createFromAlert failed for ${hit.symbol}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      }
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
