import { Injectable, Logger, Optional } from '@nestjs/common';
import { LevelBookService } from './level-book.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { ZoneRepository } from '../repositories/zone.repository';
import { OiWallService } from './oi-wall.service';
import { computeVolumeNodes, type ProfileCandle } from './volume-profile';
import { adaptiveRoundNumbers, adaptiveRoundStep, roundScore } from './adaptive-round-numbers';
import { scoreAndCluster } from './sr-evidence-scoring';
import { lookbackDaysFor } from './timeframe-lookback';
import { computeAtrFromCandles } from './per-tf-atr';
import { detectSwingPivots } from './swing-pivots';
import type { EvidenceLevel, LevelCandidate } from '../types/evidence-level.types';

interface CacheEntry { at: number; levels: EvidenceLevel[]; }
const CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Orchestrates evidence-weighted S/R: volume nodes + adaptive round numbers +
 * OI walls + pivot history -> scored, sided EvidenceLevel[]. Cached 15 min.
 * All deps optional so test/unwired containers construct cleanly; returns []
 * rather than throwing on any failure.
 */
@Injectable()
export class SrEvidenceService {
  private readonly logger = new Logger(SrEvidenceService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Optional() private readonly levelBookService?: LevelBookService,
    @Optional() private readonly angelOneAdapter?: AngelOneAdapterService,
    @Optional() private readonly marketDataRepository?: MarketDataRepository,
    @Optional() private readonly zoneRepository?: ZoneRepository,
    @Optional() private readonly oiWallService?: OiWallService,
  ) {}

  /**
   * Evidence-weighted S/R levels for a token. `interval` selects the branch:
   *
   * - `'15m'` (default — the trading/chart 15m path) is FROZEN: it computes
   *   the overlay from 5m candles + the daily `book.atr14` + the DB-stored
   *   15m zone pivots, byte-for-byte as before. Trading callers omit the
   *   arg and execute this path unchanged.
   * - any other intraday interval gets a NATIVE per-timeframe path: candles
   *   are fetched at that interval (per-TF lookback), the ATR is computed
   *   from those candles, and HISTORY candidates come from swing pivots in
   *   the same candles — never touching the shared 15m zone DB.
   */
  async levelsFor(
    token: string,
    exchange: string,
    symbol: string,
    interval: string = '15m',
  ): Promise<EvidenceLevel[]> {
    if (!token || !this.levelBookService) return [];
    const cacheKey = `${token}:${exchange}:${interval}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.levels;

    try {
      const book = await this.levelBookService.lazyLoad(token, exchange, symbol);
      if (!book) return [];
      const ltp = book.spot;
      if (!(ltp > 0)) return [];

      const isFifteen = interval === '15m';

      // Candle source + ATR unit differ by branch. 15m keeps the proven
      // 5m-candles + daily-ATR basis; non-15m uses native per-TF candles
      // and a per-TF ATR (falling back to the daily ATR only if zero).
      const candles = isFifteen
        ? await this.fetchCandles(token, exchange, '5m', 10)
        : await this.fetchCandles(token, exchange, interval, lookbackDaysFor(interval));
      const atr14 = isFifteen
        ? book.atr14
        : computeAtrFromCandles(candles, 14) || book.atr14;

      const volNodes = computeVolumeNodes(candles, atr14, ltp);
      const step = adaptiveRoundStep(ltp);
      const roundGrid = adaptiveRoundNumbers(ltp);
      const oiWalls = this.oiWallService ? await this.oiWallService.walls(symbol, ltp) : [];

      const candidates: LevelCandidate[] = [];
      for (const n of volNodes) candidates.push({ price: n.price, kind: 'VOLUME', score: n.score });
      for (const r of roundGrid) {
        const rs = roundScore(r, step);
        if (rs > 0) candidates.push({ price: r, kind: 'ROUND', score: rs });
      }
      for (const w of oiWalls) candidates.push(w);

      if (isFifteen) {
        // FROZEN 15m path — HISTORY from the DB-stored 15m zones.
        const pivots = this.zoneRepository ? await this.zoneRepository.findActiveByToken(token) : [];
        for (const p of pivots as any[]) {
          const edge = p.type === 'resistance' ? p.lower : p.upper;
          candidates.push({ price: edge, kind: 'HISTORY', score: 25 * ((p.strength ?? 0) / 100) });
        }
      } else {
        // NATIVE non-15m path — HISTORY from swing pivots in the per-TF
        // candles. Fixed score 25 (no DB strength available); never reads
        // the shared zone DB.
        for (const piv of detectSwingPivots(candles)) {
          candidates.push({ price: piv.price, kind: 'HISTORY', score: 25 });
        }
      }

      const levels = scoreAndCluster(candidates, ltp, atr14, { softRoundGrid: roundGrid });
      this.cache.set(cacheKey, { at: Date.now(), levels });
      return levels;
    } catch (err) {
      this.logger.warn(`SrEvidence levelsFor failed for ${token}: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  /**
   * Live candles at the given interval over the last `lookbackDays` via the
   * adapter; DB fallback. Generalises the old hardcoded-5m fetch — the 15m
   * branch passes `'5m'`/10 to keep its proven basis identical.
   */
  private async fetchCandles(
    token: string,
    exchange: string,
    interval: string,
    lookbackDays: number,
  ): Promise<ProfileCandle[]> {
    const now = new Date();
    const from = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    if (this.angelOneAdapter) {
      try {
        const live = await this.angelOneAdapter.getHistoricalData(token, exchange, interval, from, now);
        if (Array.isArray(live) && live.length >= 10) {
          return live.map((c: any) => ({ high: c.high, low: c.low, close: c.close, volume: Number(c.volume) }));
        }
      } catch (err) {
        this.logger.debug(`SrEvidence live ${interval} fetch failed for ${token}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (this.marketDataRepository) {
      const inst = await this.marketDataRepository.getInstrumentByToken(token);
      if (inst) {
        const rows = await this.marketDataRepository.getCandles(inst.id, interval, from, now, 800);
        return rows.map((r: any) => ({ high: r.high, low: r.low, close: r.close, volume: Number(r.volume) }));
      }
    }
    return [];
  }
}
