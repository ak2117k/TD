import { Injectable, Logger, Optional } from '@nestjs/common';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';
import type { LevelCandidate } from '../types/evidence-level.types';

/**
 * OI walls: the strikes with the most open interest act as magnets/walls.
 * Top call-OI strike = resistance, top put-OI strike = support. F&O underlyings
 * only — a cash stock has no chain, so `walls()` returns []. Never throws.
 */
@Injectable()
export class OiWallService {
  private readonly logger = new Logger(OiWallService.name);

  constructor(@Optional() private readonly optionsChain?: OptionsChainService) {}

  async walls(symbol: string): Promise<LevelCandidate[]> {
    if (!this.optionsChain || !symbol) return [];
    try {
      const expiries = await this.optionsChain.getExpiries(symbol);
      if (!expiries || expiries.length === 0) return []; // cash stock — no OI
      const chain = await this.optionsChain.getOptionsChain(symbol, expiries[0]);
      if (!Array.isArray(chain) || chain.length === 0) return [];

      const calls = chain
        .map((e: any) => ({ price: e.strikePrice, oi: e.ceData?.oi ?? 0 }))
        .filter((x) => x.oi > 0)
        .sort((a, b) => b.oi - a.oi);
      const puts = chain
        .map((e: any) => ({ price: e.strikePrice, oi: e.peData?.oi ?? 0 }))
        .filter((x) => x.oi > 0)
        .sort((a, b) => b.oi - a.oi);

      const out: LevelCandidate[] = [];
      const ranks = [30, 20];
      calls.slice(0, 2).forEach((c, i) => out.push({ price: c.price, kind: 'OI_CALL', score: ranks[i] }));
      puts.slice(0, 2).forEach((p, i) => out.push({ price: p.price, kind: 'OI_PUT', score: ranks[i] }));
      return out;
    } catch (err) {
      this.logger.debug(`OI walls failed for ${symbol}: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }
}
