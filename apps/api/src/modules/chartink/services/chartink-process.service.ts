import { Injectable, Logger } from '@nestjs/common';
import { ChartinkRepository } from '../repositories/chartink.repository';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { MtfAlignmentService } from '../../signal-generator/services/mtf-alignment.service';
import { ChartinkScoringService, classifyTrend } from './chartink-scoring.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { NseSectorIndexService } from '../../market-data/services/nse-sector-index.service';
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
    private readonly mtf: MtfAlignmentService,
    private readonly scoring: ChartinkScoringService,
    private readonly angelOne: AngelOneAdapterService,
    private readonly nseSector: NseSectorIndexService,
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
    // === 1. Resolve symbol ===
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

    // === 2. MTF gate ===
    // 4-TF directional agreement check before any deeper analysis.
    // On misalignment we persist immediately and stop to save broker calls.
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

    // === 3. SECTOR HARD GATE ===
    // NseSectorIndexService returns the sector index token directly (e.g. '99926009').
    // Strip any series suffixes before lookup since Chartink symbols may arrive bare.
    const symbolBare = hit.symbol.replace(/-EQ$|-BE$|-BL$|-IV$/, '');
    const sectorToken = this.nseSector.getSectorIndexForSymbol(symbolBare);
    if (!sectorToken) {
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'sector-misaligned',
        setupId: null,
        rejectReason: `no sector mapping for ${symbolBare}`,
      });
      return;
    }

    // Verify the sector index instrument exists in the local DB
    const sectorInstrument = await this.mdRepo.getInstrumentByToken(sectorToken);
    if (!sectorInstrument) {
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'sector-misaligned',
        setupId: null,
        rejectReason: `sector index token ${sectorToken} not in DB`,
      });
      return;
    }

    // Fetch the sector's 15m candles (same pattern as ChartinkScoringService.fetch15mCandles)
    let sectorCloses: number[];
    try {
      sectorCloses = await this.fetchSectorCloses(sectorToken, sectorInstrument.exchange ?? 'NSE');
    } catch (err) {
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'sector-misaligned',
        setupId: null,
        rejectReason: `sector candle fetch failed: ${err instanceof Error ? err.message : err}`,
      });
      return;
    }

    if (sectorCloses.length < 26) {
      // classifyTrend needs >= 26 bars (20 for EMA + 5 lookback + buffer)
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'sector-misaligned',
        setupId: null,
        rejectReason: `sector token ${sectorToken} insufficient candles (${sectorCloses.length})`,
      });
      return;
    }

    const sectorTrend = classifyTrend(sectorCloses);
    if (sectorTrend === null || sectorTrend === 'INDETERMINATE') {
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'sector-misaligned',
        setupId: null,
        rejectReason: `sector token ${sectorToken} trend ${sectorTrend ?? 'INDETERMINATE'}`,
      });
      return;
    }
    const side: 'BUY' | 'SELL' = sectorTrend === 'UP' ? 'BUY' : 'SELL';

    // === 4. SCORING ===
    let scoringResult: Awaited<ReturnType<typeof this.scoring.score>>;
    try {
      scoringResult = await this.scoring.score({
        token: instrument.token,
        symbol: hit.symbol,
        exchange: 'NSE',
        side,
        entryPrice: hit.hitPrice,
        setupContext: null,
      });
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

    // === 5. Persist + Stage 2 trigger ===
    if (scoringResult.score >= 50) {
      const persistedSetup = await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'setup',
        setupId: null,
        rejectReason: null,
        score: scoringResult.score,
        lotCount: scoringResult.lotCount,
        scoreBreakdown: scoringResult.checks,
      });

      // Wire to watch monitor (Stage 2). Failures MUST NOT block setup persistence.
      try {
        await this.watch.createFromAlert({
          alertId,
          setupId: persistedSetup.id,
          symbol: hit.symbol,
          token: instrument.token,
          exchange: 'NSE',
          side,
          initialPrice: hit.hitPrice,
          initialScore: scoringResult.score,
          initialBreakdown: { checks: scoringResult.checks, lotCount: scoringResult.lotCount } as unknown as import('@prisma/client').Prisma.InputJsonValue,
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
    } else {
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'scored-low',
        setupId: null,
        rejectReason: `score ${scoringResult.score} below 50`,
        score: scoringResult.score,
        lotCount: scoringResult.lotCount,
        scoreBreakdown: scoringResult.checks,
      });
    }
  }

  /**
   * Fetch the last 50 closes of 15m candles for a sector index token.
   * Mirrors ChartinkScoringService.fetch15mCandles — uses getHistoricalData
   * which auto-chunks and rate-paces the Angel One historical API.
   */
  private async fetchSectorCloses(token: string, exchange: string): Promise<number[]> {
    const to = new Date();
    // 7 days back gives enough bars even accounting for weekends + holidays
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const candles = (await this.angelOne.getHistoricalData(token, exchange, '15m', from, to)) as Array<{
      timestamp: Date | string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>;
    if (!candles || candles.length === 0) return [];
    // Take last 50 closes (getHistoricalData returns chronological order)
    return candles.slice(-50).map((c) => Number(c.close));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
