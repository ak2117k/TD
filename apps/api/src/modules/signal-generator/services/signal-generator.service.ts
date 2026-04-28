import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  MarketSnapshot,
  SignalOutput,
} from '../../../common/interfaces/trading-strategy.interface';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { SettingsService } from '../../settings/services/settings.service';
import { StrategyRegistryService } from './strategy-registry.service';
import { SignalScoringService } from './signal-scoring.service';
import { SignalRepository, CreateSignalInput } from '../repositories/signal.repository';
import { SignalGateway } from '../gateways/signal.gateway';
import { SignalFilterDto } from '../dto/signal.dto';
import { LevelBookService } from './level-book.service';
import { SetupTrackerService, SetupStatus, LockedSetup } from './setup-tracker.service';
import { LevelsContextStrategy, classifyRegime } from '../strategies/levels-context.strategy';
import { ema } from '../strategies/indicators';
import { SetupContext } from '../types/setup-context.types';
import { LevelBook } from '../types/level-book.types';
import {
  TIMEFRAMES,
  MARKET_OPEN_HOUR,
  MARKET_OPEN_MINUTE,
  MARKET_CLOSE_HOUR,
  MARKET_CLOSE_MINUTE,
  MCX_OPEN_HOUR,
  MCX_OPEN_MINUTE,
  MCX_CLOSE_HOUR,
  MCX_CLOSE_MINUTE,
} from '@td/shared/constants';
import { Exchange } from '@td/shared/types';

/**
 * Floor on signal lifetime — even a signal created near session close
 * should stay actionable long enough for a manual trader to react. We
 * always give the trader at least this much window.
 */
const MIN_SIGNAL_TTL_MINUTES = 120;

/**
 * Hard cap on signal lifetime. If the session-end calculation would
 * push expiry beyond this, we clamp. Prevents weekend-generated signals
 * from staying "active" through Monday.
 */
const MAX_SIGNAL_TTL_HOURS = 14;

/**
 * Compute when a signal should expire based on its exchange's session
 * close. NSE/BSE: 15:30 IST. MCX: 23:30 IST. Signals get a 2h floor
 * so end-of-session generation still gives the trader a window. If the
 * session is already closed for today (e.g. scan-now after hours),
 * defaults to MAX_SIGNAL_TTL_HOURS.
 */
function computeExpiry(exchange: string, now: Date = new Date()): Date {
  const isMcx = exchange === 'MCX';
  const closeHour = isMcx ? MCX_CLOSE_HOUR : MARKET_CLOSE_HOUR;
  const closeMinute = isMcx ? MCX_CLOSE_MINUTE : MARKET_CLOSE_MINUTE;

  // IST is UTC+5:30. Build today's session-close in UTC.
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);
  const istClose = new Date(
    Date.UTC(
      istNow.getUTCFullYear(),
      istNow.getUTCMonth(),
      istNow.getUTCDate(),
      closeHour,
      closeMinute,
      0,
      0,
    ),
  );
  const utcClose = new Date(istClose.getTime() - istOffsetMs);

  const floor = new Date(now.getTime() + MIN_SIGNAL_TTL_MINUTES * 60 * 1000);
  const cap = new Date(now.getTime() + MAX_SIGNAL_TTL_HOURS * 60 * 60 * 1000);

  // Take the later of (session-close, floor) so end-of-day signals get
  // their 2h window. Then clamp to the hard cap so off-hours signals
  // (weekends, late-night) don't live forever.
  const candidate = utcClose.getTime() > floor.getTime() ? utcClose : floor;
  return candidate.getTime() > cap.getTime() ? cap : candidate;
}

/** Minimum number of timeframes that must agree for signal confirmation. */
const MIN_TIMEFRAME_AGREEMENT = 2;

/**
 * Map a working timeframe to the next-higher timeframe used for the MTF
 * trend filter. Daily has no higher TF — null short-circuits the check.
 */
const HIGHER_TF_MAP: Record<string, string | null> = {
  '1m': '5m',
  '5m': '15m',
  '15m': '1h',
  '1h': '4h',
  '4h': '1d',
  '1d': null,
};

/** Number of higher-TF candles to fetch for the EMA9/EMA21 computation. */
const HIGHER_TF_CANDLE_TARGET = 30;

/**
 * Look-back window when fetching higher-TF candles. Generous because the
 * higher TF spans larger chunks of time per bar — 30 daily candles = 30
 * trading days, 30 hourly candles = ~5 trading days.
 */
const HIGHER_TF_LOOKBACK_DAYS = 60;

export interface LevelsSnapshot {
  pdh: number;
  pdl: number;
  orh: number | null;
  orl: number | null;
  vwap: number;
  todayHigh: number;
  todayLow: number;
  atr14: number;
}

export type AnalyzeResult =
  | {
      kind: 'setup';
      symbol: string;
      side: 'BUY' | 'SELL';
      entry: number;
      stoploss: number;
      target: number;
      partialTakeAt: number;
      trailingSl: number | null;
      levelType: SetupContext['levelType'];
      setupType: SetupContext['setupType'];
      grade: SetupContext['grade'];
      atr14: number;
      volumeRatio: number;
      levels: LevelsSnapshot;
      reason: string;
      indicators: SetupContext['indicators'];
      higherTimeframeTrend: SetupContext['higherTimeframeTrend'];
      regime: SetupContext['regime'];
      intradayRangeRatio: number;
      status: SetupStatus;
      setupId: string;
      triggeredAt: string | null;
      partialBookedAt: string | null;
    }
  | {
      kind: 'no-setup';
      reason: string;
      levels: LevelsSnapshot | null;
      higherTimeframeTrend: SetupContext['higherTimeframeTrend'];
      regime: SetupContext['regime'];
      intradayRangeRatio: number;
    };

function snapshotFromBook(book: LevelBook): LevelsSnapshot {
  return {
    pdh: book.pdh,
    pdl: book.pdl,
    orh: book.orh,
    orl: book.orl,
    vwap: book.vwap,
    todayHigh: book.todayHigh,
    todayLow: book.todayLow,
    atr14: book.atr14,
  };
}

@Injectable()
export class SignalGeneratorService {
  private readonly logger = new Logger(SignalGeneratorService.name);

  constructor(
    private readonly strategyRegistry: StrategyRegistryService,
    private readonly signalScoring: SignalScoringService,
    private readonly signalRepository: SignalRepository,
    private readonly marketFeedService: MarketFeedService,
    private readonly marketDataRepository: MarketDataRepository,
    private readonly angelOneAdapter: AngelOneAdapterService,
    private readonly settingsService: SettingsService,
    private readonly signalGateway: SignalGateway,
    private readonly levelBookService: LevelBookService,
    private readonly setupTracker: SetupTrackerService,
  ) {}

  async analyze(
    token: string,
    exchange: string,
    symbol: string,
    timeframe: string = '15m',
  ): Promise<AnalyzeResult> {
    // Locked-setup short-circuit: if there's already an active setup for
    // this token, return its FROZEN entry/SL/target rather than re-running
    // the strategy. This is the whole point of locking — every poll on the
    // same setup must return the same numbers, not drift with spot.
    const existing = this.setupTracker.getActive(token);
    if (
      existing &&
      (existing.status === 'PENDING' ||
        existing.status === 'ACTIVE' ||
        existing.status === 'PARTIAL_BOOKED')
    ) {
      const liveBook = await this.levelBookService.lazyLoad(token, exchange, symbol);
      // Update tracker against the latest spot so PENDING -> ACTIVE etc.
      // transitions don't lag behind the chart.
      if (liveBook) {
        this.setupTracker.updateFromTick(token, liveBook.spot, new Date());
      }
      const refreshed = this.setupTracker.getActive(token) ?? existing;
      return this.lockedToResult(refreshed, liveBook);
    }

    const book = await this.levelBookService.lazyLoad(token, exchange, symbol);
    if (!book) {
      return {
        kind: 'no-setup',
        reason: 'no level book available — symbol has no historical data',
        levels: null,
        higherTimeframeTrend: null,
        regime: null,
        intradayRangeRatio: 0,
      };
    }

    // Daily regime — driven by today's intraday range vs ATR14. Computed
    // once per analyze() call and threaded into the strategy via AnalyzeInput.
    const { regime, intradayRangeRatio } = classifyRegime({
      intradayRange: book.todayHigh - book.todayLow,
      atr14: book.atr14,
    });

    const instrument = await this.marketDataRepository.getInstrumentByToken(token);
    const now = new Date();
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

    // Try DB first when the symbol is seeded; fall back to broker
    // historical API otherwise (any stock the user picks via search).
    let candles: Array<{
      timestamp: Date; open: number; high: number; low: number; close: number; volume: number;
    }> = [];
    if (instrument) {
      const candleRows = await this.marketDataRepository.getCandles(
        instrument.id, timeframe, fiveDaysAgo, now, 25,
      );
      candles = candleRows.map((c) => ({
        timestamp: c.timestamp,
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: typeof c.volume === 'bigint' ? Number(c.volume) : c.volume,
      }));
    }
    if (candles.length < 25) {
      try {
        const broker = await this.angelOneAdapter.getHistoricalData(
          token, exchange, timeframe, fiveDaysAgo, now,
        );
        candles = broker.slice(-30).map((c: any) => ({
          timestamp: new Date(c.timestamp),
          open: Number(c.open), high: Number(c.high),
          low: Number(c.low), close: Number(c.close),
          volume: Number(c.volume) || 0,
        }));
      } catch (err) {
        this.logger.warn(
          `analyze: broker candles fetch failed for ${symbol}/${timeframe}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (candles.length < 25) {
      return {
        kind: 'no-setup',
        reason: `not enough candles (got ${candles.length}, need 25 for ${timeframe})`,
        levels: snapshotFromBook(book),
        higherTimeframeTrend: null,
        regime,
        intradayRangeRatio,
      };
    }

    // Compute the higher-TF trend bias for the MTF gate. If the working
    // TF is daily (no defined higher TF) or if the higher-TF candle fetch
    // can't return enough data, this stays null and the strategy skips the
    // gate (defensive — never let a transient broker error suppress
    // signals).
    const higherTimeframeTrend = await this.computeHigherTimeframeTrend(
      token,
      exchange,
      timeframe,
      instrument?.id ?? null,
      now,
    );

    const istParts = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hh = istParts.find((p) => p.type === 'hour')?.value ?? '00';
    const mm = istParts.find((p) => p.type === 'minute')?.value ?? '00';
    const nowIst = `${hh === '24' ? '00' : hh}:${mm}`;

    const strategy = new LevelsContextStrategy();
    strategy.setParameters({ includeGradeC: true });

    let lastReject = '<gates not evaluated>';
    const debug = (event: string, detail?: Record<string, unknown>) => {
      if (event.startsWith('reject:')) {
        lastReject = detail ? `${event} ${JSON.stringify(detail)}` : event;
      }
    };

    // Bypass staleness here. analyze is invoked on demand by the chart;
    // we're explicitly running historical-or-recent analysis, not waiting
    // for a fresh tick. Pin nowMs to the book's lastTickAt so the
    // staleness gate (1min wall-clock window) always passes. The
    // time-of-day gate still uses real IST so "market closed" returns
    // a useful no-setup reason ("reject:outside-window") instead of a
    // misleading "reject:stale".
    const nowMsForStrategy = book.lastTickAt.getTime() + 1000;
    const output = strategy.analyze({
      candles,
      levelBook: book,
      nowIst,
      nowMs: nowMsForStrategy,
      higherTimeframeTrend,
      regime,
      debug,
    });

    if (!output) {
      return {
        kind: 'no-setup',
        reason: lastReject,
        levels: snapshotFromBook(book),
        higherTimeframeTrend,
        regime,
        intradayRangeRatio,
      };
    }

    const ctx = output.metadata as SetupContext;
    const locked = this.setupTracker.lock({
      token,
      symbol: output.symbol,
      exchange: output.exchange,
      side: output.side,
      setupType: ctx.setupType,
      levelType: ctx.levelType,
      levelValue: ctx.levelValue,
      entry: ctx.entry,
      stoploss: ctx.stoploss,
      target: ctx.target,
      partialTakeAt: ctx.partialTakeAt,
      grade: ctx.grade,
      atr14: ctx.atr14,
      indicators: ctx.indicators,
      higherTimeframeTrend: ctx.higherTimeframeTrend,
      regime: ctx.regime,
      intradayRangeRatio: ctx.intradayRangeRatio,
      reason: output.reason,
    });
    // lock() returns null when there's already an active setup — fall back
    // to whatever's active (defensive; the short-circuit above usually
    // catches this path first).
    const final = locked ?? this.setupTracker.getActive(token);
    if (!final) {
      return {
        kind: 'no-setup',
        reason: 'failed to lock setup',
        levels: snapshotFromBook(book),
        higherTimeframeTrend,
        regime,
        intradayRangeRatio,
      };
    }
    return this.lockedToResult(final, book);
  }

  private lockedToResult(
    setup: LockedSetup,
    book: LevelBook | null,
  ): AnalyzeResult {
    return {
      kind: 'setup',
      symbol: setup.symbol,
      side: setup.side,
      entry: setup.entry,
      stoploss: setup.stoploss,
      target: setup.target,
      partialTakeAt: setup.partialTakeAt,
      trailingSl: setup.trailingSl,
      levelType: setup.levelType,
      setupType: setup.setupType,
      grade: setup.grade,
      atr14: setup.atr14,
      // volumeRatio is part of the original setupContext but not held by
      // the locked record — surface 0 when re-serving an existing lock.
      volumeRatio: 0,
      levels: book
        ? snapshotFromBook(book)
        : {
            pdh: 0, pdl: 0, orh: null, orl: null,
            vwap: 0, todayHigh: 0, todayLow: 0, atr14: setup.atr14,
          },
      reason: setup.reason,
      indicators: setup.indicators,
      higherTimeframeTrend: setup.higherTimeframeTrend,
      regime: setup.regime,
      intradayRangeRatio: setup.intradayRangeRatio,
      status: setup.status,
      setupId: setup.id,
      triggeredAt: setup.triggeredAt ? setup.triggeredAt.toISOString() : null,
      partialBookedAt: setup.partialBookedAt
        ? setup.partialBookedAt.toISOString()
        : null,
    };
  }

  /**
   * Run all active strategies against a market snapshot.
   * Scores results, filters by multi-timeframe confirmation, saves to DB,
   * and emits via WebSocket gateway.
   */
  async scanForSignals(snapshot: MarketSnapshot): Promise<void> {
    const strategies = await this.strategyRegistry.getActiveStrategies();

    if (strategies.length === 0) {
      this.logger.debug('No active strategies to scan with');
      return;
    }

    const rawSignals: Array<{ signal: SignalOutput; strategyName: string }> = [];

    for (const strategy of strategies) {
      try {
        const signal = strategy.analyze(snapshot);
        if (signal) {
          rawSignals.push({ signal, strategyName: strategy.name });
          this.logger.debug(
            `[${strategy.name}] ${snapshot.symbol}: SIGNAL ${signal.side} @ ${signal.entryPrice} (candles: ${snapshot.candles.length})`,
          );
        } else {
          this.logger.debug(
            `[${strategy.name}] ${snapshot.symbol}: no signal (candles: ${snapshot.candles.length}, ltp: ${snapshot.ltp})`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Strategy "${strategy.name}" error for ${snapshot.symbol}: ` +
            `${error instanceof Error ? error.message : error}`,
        );
      }
    }

    if (rawSignals.length === 0) {
      return;
    }

    // Multi-timeframe confirmation: count how many signals agree on direction
    const directionCounts = this.countDirectionAgreements(rawSignals);

    for (const { signal, strategyName } of rawSignals) {
      const timeframeAlignments = directionCounts[signal.side] ?? 1;

      // Skip signals that don't meet multi-timeframe minimum
      if (timeframeAlignments < MIN_TIMEFRAME_AGREEMENT && rawSignals.length > 1) {
        this.logger.debug(
          `Signal for ${signal.symbol} ${signal.side} skipped — ` +
            `only ${timeframeAlignments} TF agreement (need ${MIN_TIMEFRAME_AGREEMENT})`,
        );
        continue;
      }

      const scoreResult = await this.signalScoring.scoreSignal(
        signal,
        snapshot,
        strategyName,
        timeframeAlignments,
      );

      if (!scoreResult) {
        continue; // Discarded by scoring (below threshold)
      }

      try {
        const savedSignal = await this.saveSignal(
          signal,
          snapshot,
          strategyName,
          scoreResult.score,
          scoreResult.confidence,
        );

        this.signalGateway.emitNewSignal(savedSignal);

        this.logger.log(
          `Signal generated: ${signal.symbol} ${signal.side} @ ${signal.entryPrice} ` +
            `[${strategyName}] score=${scoreResult.score} (${scoreResult.confidence})`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to save signal for ${signal.symbol}: ` +
            `${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  /**
   * Scan all instruments in the current watchlist.
   * Falls back to all cached quote tokens when no WebSocket subscriptions exist.
   */
  async scanAllWatchlist(): Promise<void> {
    let tokens = this.marketFeedService.getSubscribedTokens();

    // Fall back to all tokens that have cached quotes (from REST polling)
    if (tokens.length === 0) {
      const allQuotes = this.marketFeedService.getAllQuotes();
      tokens = allQuotes.map((q) => q.token);
    }

    if (tokens.length === 0) {
      this.logger.debug('No subscribed tokens or cached quotes to scan');
      return;
    }

    // Determine which exchanges are currently open so we skip stale data
    const nseOpen = this.isExchangeOpen('NSE');
    const mcxOpen = this.isExchangeOpen('MCX');

    this.logger.log(
      `Scanning ${tokens.length} instruments for signals (NSE: ${nseOpen ? 'OPEN' : 'CLOSED'}, MCX: ${mcxOpen ? 'OPEN' : 'CLOSED'})`,
    );

    let scanned = 0;
    let skipped = 0;

    for (const token of tokens) {
      try {
        // Check if the token's exchange is currently open
        const quote = this.marketFeedService.getQuote(token);
        if (quote) {
          const exchange = quote.exchange;
          const isMcx = exchange === Exchange.MCX;
          const isNseOrBse =
            exchange === Exchange.NSE ||
            exchange === Exchange.BSE ||
            exchange === Exchange.NFO;

          if (isMcx && !mcxOpen) {
            skipped++;
            continue;
          }
          if (isNseOrBse && !nseOpen) {
            skipped++;
            continue;
          }
        }

        const snapshot = await this.buildSnapshotForToken(token);
        if (snapshot) {
          await this.scanForSignals(snapshot);
          scanned++;
        }
      } catch (error) {
        this.logger.error(
          `Error scanning token ${token}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    if (skipped > 0) {
      this.logger.debug(
        `Skipped ${skipped} tokens (exchange closed), scanned ${scanned}`,
      );
    }
  }

  /**
   * Get currently active signals, plus optionally recently-expired ones
   * from the last `recentHours` window. The Signals page uses the recent
   * window so a trader checking in mid-afternoon can still see the
   * morning's signals (now expired but still informative).
   */
  async getActiveSignals(recentHours = 0) {
    return this.signalRepository.getActiveSignals(recentHours);
  }

  /**
   * Get signal history with filters and pagination.
   */
  async getSignalHistory(filters: SignalFilterDto) {
    return this.signalRepository.getSignalHistory(filters);
  }

  /**
   * Deactivate a signal by ID.
   */
  async deactivateSignal(id: string) {
    const signal = await this.signalRepository.deactivateSignal(id);
    this.signalGateway.emitSignalExpired(id);
    return signal;
  }

  /**
   * Cron job to deactivate signals whose expiresAt has passed.
   * Fires every 5 minutes between 09:00–23:35 IST (Mon-Fri) so it
   * covers both NSE close (15:30) and MCX close (23:30). Each signal's
   * TTL is set at creation time by computeExpiry() — this cron just
   * sweeps the ones that are past due.
   */
  @Cron('*/5 9-23 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async expireOldSignals(): Promise<void> {
    try {
      const count = await this.signalRepository.deactivateExpiredSignals();

      if (count > 0) {
        this.logger.log(`Expired ${count} old signals`);
      }
    } catch (error) {
      this.logger.error(
        `Error expiring signals: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // ------------------------------------------------------------------
  //  Private helpers
  // ------------------------------------------------------------------

  /**
   * Check whether a specific exchange is currently open (IST-based).
   * NSE/BSE/NFO: 9:15 – 15:30, Mon–Fri
   * MCX: 9:00 – 23:30, Mon–Fri
   */
  private isExchangeOpen(exchange: 'NSE' | 'MCX'): boolean {
    const now = new Date();
    const istParts = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
      hour12: false,
    }).formatToParts(now);

    const weekday = istParts.find((p) => p.type === 'weekday')?.value ?? '';
    if (weekday === 'Sat' || weekday === 'Sun') return false;

    const hours = Number(istParts.find((p) => p.type === 'hour')?.value ?? 0);
    const minutes = Number(
      istParts.find((p) => p.type === 'minute')?.value ?? 0,
    );
    const totalMinutes = hours * 60 + minutes;

    if (exchange === 'MCX') {
      const mcxOpen = MCX_OPEN_HOUR * 60 + MCX_OPEN_MINUTE;
      const mcxClose = MCX_CLOSE_HOUR * 60 + MCX_CLOSE_MINUTE;
      return totalMinutes >= mcxOpen && totalMinutes <= mcxClose;
    }

    // NSE/BSE/NFO
    const nseOpen = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MINUTE;
    const nseClose = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MINUTE;
    return totalMinutes >= nseOpen && totalMinutes <= nseClose;
  }

  /**
   * Build a MarketSnapshot from a token's cached quote and recent candles.
   * Tries the DB first, then falls back to fetching historical data from the
   * Angel One REST API so that strategies have enough candles for indicator
   * calculations (RSI, EMA, ATR, etc.).
   */
  private async buildSnapshotForToken(
    token: string,
  ): Promise<MarketSnapshot | null> {
    const quote = this.marketFeedService.getQuote(token);
    if (!quote) {
      return null;
    }

    // We need enough candles for the most demanding strategy.
    // EMA crossover needs signalPeriod(50) + 2 = 52 candles minimum.
    // RSI needs 26+ candles. Use 5 days of 15-min candles (~125 candles)
    // to ensure sufficient data even for commodities with limited intraday history.
    const now = new Date();
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

    let candles: Array<{
      timestamp: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: bigint | number;
    }> = [];

    try {
      // Look up instrument by token to get instrumentId
      const instrument = await this.marketDataRepository.getInstrumentByToken(token);
      if (instrument) {
        const dbCandles = await this.marketDataRepository.getCandles(
          instrument.id,
          TIMEFRAMES.FIFTEEN_MIN,
          fiveDaysAgo,
          now,
        );
        candles = dbCandles;
      }
    } catch (error) {
      this.logger.debug(
        `Could not fetch candles from DB for token ${token}: ${error instanceof Error ? error.message : error}`,
      );
    }

    // If DB has insufficient candles, fetch from Angel One REST API directly
    if (candles.length < 52) {
      try {
        const apiCandles = await this.angelOneAdapter.getHistoricalData(
          token,
          quote.exchange,
          TIMEFRAMES.FIFTEEN_MIN,
          fiveDaysAgo,
          now,
        );

        if (apiCandles && apiCandles.length > candles.length) {
          candles = apiCandles;
          this.logger.debug(
            `Fetched ${apiCandles.length} candles from API for ${quote.symbol} (DB had ${candles.length})`,
          );
        }
      } catch (error) {
        this.logger.debug(
          `Could not fetch candles from API for token ${token}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    return {
      symbol: quote.symbol,
      exchange: quote.exchange,
      ltp: quote.ltp,
      volume: quote.volume,
      candles: candles.map((c) => ({
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: typeof c.volume === 'bigint' ? Number(c.volume) : c.volume,
      })),
    };
  }

  /**
   * Compute the higher-TF trend bias (bullish/bearish/neutral) from EMA9
   * vs EMA21 on the most-recent CLOSED candle of the higher TF. Returns
   * null when:
   *   • the working TF has no defined higher TF (e.g. 1d)
   *   • we couldn't fetch enough higher-TF candles
   *   • EMA computation fails (insufficient series length)
   *
   * The strategy treats null as "skip the gate" so a transient broker
   * failure here never suppresses signals.
   */
  private async computeHigherTimeframeTrend(
    token: string,
    exchange: string,
    workingTimeframe: string,
    instrumentId: string | null,
    now: Date,
  ): Promise<SetupContext['higherTimeframeTrend']> {
    const higherTf = HIGHER_TF_MAP[workingTimeframe];
    if (!higherTf) return null;

    const from = new Date(
      now.getTime() - HIGHER_TF_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    );

    let candles: Array<{ close: number }> = [];

    if (instrumentId) {
      try {
        const dbRows = await this.marketDataRepository.getCandles(
          instrumentId,
          higherTf,
          from,
          now,
          HIGHER_TF_CANDLE_TARGET,
        );
        candles = dbRows.map((c) => ({ close: c.close }));
      } catch (err) {
        this.logger.debug(
          `MTF DB fetch failed for token ${token} ${higherTf}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (candles.length < 22) {
      try {
        const broker = await this.angelOneAdapter.getHistoricalData(
          token, exchange, higherTf, from, now,
        );
        candles = (broker as Array<{ close: number | string }>).slice(
          -HIGHER_TF_CANDLE_TARGET,
        ).map((c) => ({ close: Number(c.close) }));
      } catch (err) {
        this.logger.debug(
          `MTF broker fetch failed for token ${token} ${higherTf}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (candles.length < 22) return null;

    // Use the most-recent CLOSED bar (length-2). If only one bar is
    // present we can't safely drop the in-progress one; fall back to the
    // last available close.
    const closesUpToClosed =
      candles.length >= 2
        ? candles.slice(0, -1).map((c) => c.close)
        : candles.map((c) => c.close);

    const ema9Val = ema(closesUpToClosed, 9);
    const ema21Val = ema(closesUpToClosed, 21);
    if (ema9Val == null || ema21Val == null) return null;

    let bias: 'bullish' | 'bearish' | 'neutral';
    if (ema9Val > ema21Val * 1.001) bias = 'bullish';
    else if (ema9Val < ema21Val * 0.999) bias = 'bearish';
    else bias = 'neutral';

    return { tf: higherTf, ema9: ema9Val, ema21: ema21Val, bias };
  }

  /**
   * Count how many strategies agree on each direction (BUY/SELL).
   * Used for multi-strategy confirmation. Counts unique strategies, not
   * unique timeframes, so that two strategies on the same timeframe still
   * provide confirmation.
   */
  private countDirectionAgreements(
    signals: Array<{ signal: SignalOutput; strategyName: string }>,
  ): Record<string, number> {
    const counts: Record<string, number> = { BUY: 0, SELL: 0 };

    const buyStrategies = new Set<string>();
    const sellStrategies = new Set<string>();

    for (const { signal, strategyName } of signals) {
      if (signal.side === 'BUY') {
        buyStrategies.add(strategyName);
      } else {
        sellStrategies.add(strategyName);
      }
    }

    counts.BUY = buyStrategies.size;
    counts.SELL = sellStrategies.size;

    return counts;
  }

  /**
   * Save a scored signal to the database.
   */
  private async saveSignal(
    signal: SignalOutput,
    snapshot: MarketSnapshot,
    strategyName: string,
    score: number,
    confidence: string,
  ) {
    // Resolve instrumentId from the symbol/exchange
    let instrumentId: string | null = null;

    try {
      const instruments = await this.marketDataRepository.searchInstruments(
        signal.symbol,
        signal.exchange,
      );
      if (instruments.length > 0) {
        instrumentId = instruments[0].id;
      }
    } catch {
      // Will use a fallback if instrument not found
    }

    if (!instrumentId) {
      this.logger.warn(
        `Instrument not found for ${signal.symbol}/${signal.exchange} — skipping signal save`,
      );
      throw new Error(`Instrument not found for ${signal.symbol}`);
    }

    const expectedProfit = Math.abs(signal.targetPrice - signal.entryPrice);
    const expectedLoss = Math.abs(signal.entryPrice - signal.stoplossPrice);
    const riskRewardRatio = expectedLoss > 0 ? expectedProfit / expectedLoss : 0;

    const expiresAt = computeExpiry(signal.exchange);

    const input: CreateSignalInput = {
      instrumentId,
      side: signal.side,
      entryPrice: signal.entryPrice,
      targetPrice: signal.targetPrice,
      stoplossPrice: signal.stoplossPrice,
      expectedProfit: Math.round(expectedProfit * 100) / 100,
      expectedLoss: Math.round(expectedLoss * 100) / 100,
      riskRewardRatio: Math.round(riskRewardRatio * 100) / 100,
      confidence,
      confidenceScore: score,
      strategy: strategyName,
      timeframe: signal.timeframe,
      reason: signal.reason,
      expiresAt,
    };

    return this.signalRepository.createSignal(input);
  }
}
