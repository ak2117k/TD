import { Injectable, Logger } from '@nestjs/common';
import { ChartinkRepository, CreateAlertSetupInput } from '../repositories/chartink.repository';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { ChartinkScoringService, classifyTrend } from './chartink-scoring.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { NseSectorIndexService } from '../../market-data/services/nse-sector-index.service';
import { WatchService, WatchCapExceededError, TradeCooldownError } from '../../watch-monitor/services/watch.service';
import { formatTradeRejection } from '../../../common/utils/trade-rejection-log';
import { isWithinEntryWindow } from '../../../common/utils/market-hours';
import { evaluateTradePolicy } from '../../watch-monitor/services/trade-policy';
import { UngatedWatchService, UngatedSymbolDupError, UngatedCooldownError } from '../../ungated-track/services/ungated-watch.service';
import { UngatedRejectionRepository, UngatedRejectionReason } from '../../ungated-track/repositories/ungated-rejection.repository';
import {
  UngatedCapitalExhaustedError, UngatedPositionCapError, UngatedKillSwitchError,
} from '../../ungated-track/services/ungated-paper-account.service';

interface Hit {
  symbol: string;
  hitPrice: number;
}

/**
 * Outcome kinds that mean "not traded". Each one maps to a pipeline stage for
 * the [trade-rejected] log line. `setup` is the only non-rejection kind, so it
 * never flows through {@link ChartinkProcessService.rejectSetup}.
 *
 * The pipeline is now pure score-based: the three misalignment-veto kinds
 * (`mtf-misaligned`, `macd-misaligned`, `supertrend-misaligned`) are NEVER
 * produced here — misalignment only lowers the 0-100 score — so they are
 * excluded from {@link RejectKind}.
 */
type RejectKind = Exclude<
  CreateAlertSetupInput['kind'],
  'setup' | 'no-setup' | 'sector-misaligned' | 'mtf-misaligned' | 'macd-misaligned' | 'supertrend-misaligned'
>;

const REJECT_STAGE: Record<RejectKind, 'ingest' | 'process' | 'scoring'> = {
  unresolved: 'process',
  'no-direction': 'process',
  'scored-low': 'scoring',
  error: 'scoring',
  // 15:00 IST entry cutoff — rejected before any processing/scoring work.
  'market-closed': 'ingest',
};

const RATE_LIMIT_MS = 350;

@Injectable()
export class ChartinkProcessService {
  private readonly logger = new Logger(ChartinkProcessService.name);

  constructor(
    private readonly repo: ChartinkRepository,
    private readonly mdRepo: MarketDataRepository,
    private readonly scoring: ChartinkScoringService,
    private readonly angelOne: AngelOneAdapterService,
    private readonly nseSector: NseSectorIndexService,
    private readonly watch: WatchService,
    private readonly ungatedWatch: UngatedWatchService,
    private readonly ungatedRejections: UngatedRejectionRepository,
  ) {}

  async processAlert(alertId: string, hits: Hit[]): Promise<void> {
    this.logger.log(`Processing Chartink alert ${alertId} — ${hits.length} hits`);
    // Resolve the Chartink scanner name once so every [trade-rejected] line
    // can show which scan the stock came from. Best-effort — a lookup failure
    // must not block processing.
    let scanName: string | undefined;
    try {
      const alert = await this.repo.getAlertWithSetups(alertId);
      scanName = alert?.scanner?.scanName ?? undefined;
    } catch (err) {
      this.logger.warn(
        `could not resolve scanner name for alert ${alertId}: ${err instanceof Error ? err.message : err}`,
      );
    }
    for (let i = 0; i < hits.length; i++) {
      try {
        await this.processOne(alertId, hits[i], scanName);
      } catch (err) {
        this.logger.warn(
          `processOne unexpected throw for ${hits[i].symbol}: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (i < hits.length - 1) await this.sleep(RATE_LIMIT_MS);
    }
  }

  /**
   * Persist a non-tradeable outcome AND emit the shared [trade-rejected] log
   * line so the API terminal explains every stock that did not become a trade.
   * Behaviour of the DB write is identical to a bare `repo.createAlertSetup`
   * call — this only ADDS the console log.
   */
  private async rejectSetup(
    input: CreateAlertSetupInput & { kind: RejectKind; rejectReason: string },
    ctx: { scan?: string; side?: 'BUY' | 'SELL' },
  ): Promise<void> {
    await this.repo.createAlertSetup(input);
    const line = formatTradeRejection({
      symbol: input.symbol,
      stage: REJECT_STAGE[input.kind],
      reason: input.rejectReason,
      scan: ctx.scan,
      hitPrice: input.hitPrice,
      side: ctx.side,
      score: input.score ?? undefined,
    });
    // `error` is an abnormal outcome (scoring threw) — surface it as a warning.
    if (input.kind === 'error') this.logger.warn(line);
    else this.logger.log(line);
  }

  async processOne(alertId: string, hit: Hit, scanName?: string): Promise<void> {
    // === 0. ENTRY-WINDOW GATE (15:00 IST cutoff) ===
    // No new WATCHING entry may be opened after 15:00 IST (or before 09:15,
    // or on a weekend). Reject BEFORE any symbol resolution / scoring / broker
    // work so a late Chartink alert costs nothing. This gates OPENING only —
    // the rescore loop and every exit path keep running until 15:30 / EOD.
    if (!isWithinEntryWindow()) {
      await this.rejectSetup(
        {
          alertId,
          symbol: hit.symbol,
          token: null,
          hitPrice: hit.hitPrice,
          kind: 'market-closed',
          setupId: null,
          rejectReason: 'outside entry window 09:15-15:00 IST',
        },
        { scan: scanName },
      );
      return;
    }

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
      await this.rejectSetup(
        {
          alertId,
          symbol: hit.symbol,
          token: null,
          hitPrice: hit.hitPrice,
          kind: 'unresolved',
          setupId: null,
          rejectReason: `symbol not in local DB (tried ${SUFFIXES.map(s => s || 'bare').join(', ')})`,
        },
        { scan: scanName },
      );
      return;
    }

    // === 2. DIRECTION GATE (sector trend, with stock-trend fallback) ===
    // We prefer to derive side from the stock's sector index trend. If the
    // sector lookup or its data is unavailable for ANY reason, we fall back
    // to the stock's own 15m trend. Only when BOTH sources are unclear do we
    // skip with 'no-direction'.
    //
    // NseSectorIndexService returns the sector index token directly (e.g. '99926009').
    // Strip any series suffixes since Chartink symbols may arrive bare.
    const symbolBare = hit.symbol.replace(/-EQ$|-BE$|-BL$|-IV$/, '');

    let side: 'BUY' | 'SELL' | null = null;
    let directionSource: 'sector' | 'stock' = 'sector';
    let sectorReason: string | null = null;

    const sectorToken = await this.nseSector.getSectorIndexForSymbol(symbolBare);
    if (!sectorToken) {
      sectorReason = `no sector mapping for ${symbolBare}`;
    } else {
      const sectorInstrument = await this.mdRepo.getInstrumentByToken(sectorToken);
      if (!sectorInstrument) {
        sectorReason = `sector index token ${sectorToken} not in DB`;
      } else {
        try {
          const sectorCloses = await this.fetchRecentCloses(
            sectorToken,
            sectorInstrument.exchange ?? 'NSE',
          );
          if (sectorCloses.length < 26) {
            sectorReason = `sector ${sectorToken} insufficient candles (${sectorCloses.length})`;
          } else {
            const sectorTrend = classifyTrend(sectorCloses);
            if (sectorTrend === 'UP') side = 'BUY';
            else if (sectorTrend === 'DOWN') side = 'SELL';
            else sectorReason = `sector ${sectorToken} trend ${sectorTrend ?? 'null'}`;
          }
        } catch (err) {
          sectorReason = `sector candle fetch failed: ${err instanceof Error ? err.message : err}`;
        }
      }
    }

    // Fall back to the stock's own 15m trend when the sector gate didn't yield a side.
    let stockReason: string | null = null;
    if (!side) {
      directionSource = 'stock';
      try {
        const stockCloses = await this.fetchRecentCloses(instrument.token, 'NSE');
        if (stockCloses.length >= 26) {
          const stockTrend = classifyTrend(stockCloses);
          if (stockTrend === 'UP') side = 'BUY';
          else if (stockTrend === 'DOWN') side = 'SELL';
          else stockReason = `stock 15m trend ${stockTrend ?? 'null'}`;
        } else {
          stockReason = `stock insufficient candles (${stockCloses.length})`;
        }
      } catch (err) {
        // Don't swallow — capture the failure so the [trade-rejected] line explains it.
        stockReason = `stock candle fetch failed: ${err instanceof Error ? err.message : err}`;
      }
    }

    if (!side) {
      await this.rejectSetup(
        {
          alertId,
          symbol: hit.symbol,
          token: instrument.token,
          hitPrice: hit.hitPrice,
          kind: 'no-direction',
          setupId: null,
          rejectReason: `sector: ${sectorReason ?? 'unknown'}; stock trend also unclear (${stockReason ?? 'unknown'})`,
        },
        { scan: scanName },
      );
      return;
    }

    if (directionSource === 'stock') {
      this.logger.debug(
        `${hit.symbol} side=${side} via stock-trend fallback (sector: ${sectorReason})`,
      );
    }

    // === 3. SCORING ===
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
      await this.rejectSetup(
        {
          alertId,
          symbol: hit.symbol,
          token: instrument.token,
          hitPrice: hit.hitPrice,
          kind: 'error',
          setupId: null,
          rejectReason: err instanceof Error ? err.message : String(err),
        },
        { scan: scanName, side },
      );
      return;
    }

    // === 4. Persist + Stage 2 trigger ===
    // R3: admission is delegated to the trade policy - score >= 60 normally,
    // but score >= 75 inside the 11:45-14:00 IST window.
    const policy = evaluateTradePolicy({ score: scoringResult.score, at: new Date() });
    if (policy.admitted) {
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
          this.logger.warn(`watch cap exceeded - skipping ${hit.symbol}`);
        } else if (err instanceof TradeCooldownError) {
          this.logger.log(`cooldown active - skipping ${hit.symbol}`);
        } else {
          this.logger.warn(
            `watch.createFromAlert failed for ${hit.symbol}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    } else {
      await this.rejectSetup(
        {
          alertId,
          symbol: hit.symbol,
          token: instrument.token,
          hitPrice: hit.hitPrice,
          kind: 'scored-low',
          setupId: null,
          rejectReason: policy.reason ?? `score ${scoringResult.score} below ${policy.minScore}`,
          score: scoringResult.score,
          lotCount: scoringResult.lotCount,
          scoreBreakdown: scoringResult.checks,
        },
        { scan: scanName, side },
      );
    }

    // === 5. UNGATED shadow track — runs unconditionally for every scored alert.
    // Independent try/catch: failures here MUST NOT affect the gated path.
    // See specs/2026-05-20-ungated-shadow-track-design.md §5.1.
    try {
      await this.ungatedWatch.createFromAlert({
        alertId,
        setupId: null,
        symbol: hit.symbol,
        token: instrument.token,
        exchange: 'NSE',
        side,
        initialPrice: hit.hitPrice,
        initialScore: scoringResult.score,
        initialBreakdown: { checks: scoringResult.checks, lotCount: scoringResult.lotCount } as any,
      });
    } catch (err) {
      const reason = this.mapUngatedError(err);
      if (reason) {
        await this.ungatedRejections.record({
          alertId, symbol: hit.symbol, reason,
          score: scoringResult.score, hitPrice: hit.hitPrice,
        });
      } else {
        this.logger.warn(`[ungated] ${hit.symbol}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private mapUngatedError(err: unknown): UngatedRejectionReason | null {
    if (err instanceof UngatedCapitalExhaustedError) return 'capital-exhausted';
    if (err instanceof UngatedPositionCapError) return 'position-cap';
    if (err instanceof UngatedSymbolDupError) return 'symbol-dup';
    if (err instanceof UngatedCooldownError) return 'cooldown';
    if (err instanceof UngatedKillSwitchError) return 'kill-switch';
    return null;
  }

  /**
   * Fetch the last 50 closes of 15m candles for any token (sector index OR stock).
   * Mirrors ChartinkScoringService.fetch15mCandles — uses getHistoricalData
   * which auto-chunks and rate-paces the Angel One historical API.
   */
  private async fetchRecentCloses(token: string, exchange: string): Promise<number[]> {
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
