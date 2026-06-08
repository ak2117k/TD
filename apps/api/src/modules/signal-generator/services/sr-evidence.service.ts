import { Injectable, Logger, Optional } from '@nestjs/common';
import { LevelBookService } from './level-book.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { ZoneRepository } from '../repositories/zone.repository';
import { OiWallService } from './oi-wall.service';
import { computeVolumeNodes, type ProfileCandle } from './volume-profile';
import { adaptiveRoundNumbers, adaptiveRoundStep, roundScore } from './adaptive-round-numbers';
import { scoreAndCluster } from './sr-evidence-scoring';
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

  async levelsFor(token: string, exchange: string, symbol: string): Promise<EvidenceLevel[]> {
    if (!token || !this.levelBookService) return [];
    const cacheKey = `${token}:${exchange}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.levels;

    try {
      const book = await this.levelBookService.lazyLoad(token, exchange, symbol);
      if (!book) return [];
      const ltp = book.spot;
      const atr14 = book.atr14;
      if (!(ltp > 0)) return [];

      const candles5m = await this.fetch5mCandles(token, exchange);
      const volNodes = computeVolumeNodes(candles5m, atr14, ltp);
      const step = adaptiveRoundStep(ltp);
      const roundGrid = adaptiveRoundNumbers(ltp);
      const oiWalls = this.oiWallService ? await this.oiWallService.walls(symbol) : [];
      const pivots = this.zoneRepository ? await this.zoneRepository.findActiveByToken(token) : [];

      const candidates: LevelCandidate[] = [];
      for (const n of volNodes) candidates.push({ price: n.price, kind: 'VOLUME', score: n.score });
      for (const r of roundGrid) {
        const rs = roundScore(r, step);
        if (rs > 0) candidates.push({ price: r, kind: 'ROUND', score: rs });
      }
      for (const w of oiWalls) candidates.push(w);
      for (const p of pivots as any[]) {
        const edge = p.type === 'resistance' ? p.lower : p.upper;
        candidates.push({ price: edge, kind: 'HISTORY', score: 25 * ((p.strength ?? 0) / 100) });
      }

      const levels = scoreAndCluster(candidates, ltp, atr14, { softRoundGrid: roundGrid });
      this.cache.set(cacheKey, { at: Date.now(), levels });
      return levels;
    } catch (err) {
      this.logger.warn(`SrEvidence levelsFor failed for ${token}: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  /** Live 5m candles (last 10 days) via the adapter; DB fallback. */
  private async fetch5mCandles(token: string, exchange: string): Promise<ProfileCandle[]> {
    const now = new Date();
    const from = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    if (this.angelOneAdapter) {
      try {
        const live = await this.angelOneAdapter.getHistoricalData(token, exchange, '5m', from, now);
        if (Array.isArray(live) && live.length >= 10) {
          return live.map((c: any) => ({ high: c.high, low: c.low, close: c.close, volume: Number(c.volume) }));
        }
      } catch (err) {
        this.logger.debug(`SrEvidence live 5m fetch failed for ${token}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (this.marketDataRepository) {
      const inst = await this.marketDataRepository.getInstrumentByToken(token);
      if (inst) {
        const rows = await this.marketDataRepository.getCandles(inst.id, '5m', from, now, 800);
        return rows.map((r: any) => ({ high: r.high, low: r.low, close: r.close, volume: Number(r.volume) }));
      }
    }
    return [];
  }
}
