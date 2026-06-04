import { Injectable, Logger } from '@nestjs/common';
import { AnandDualTrackRepository } from '../repositories/anand-dual-track.repository';

export interface CreateEntriesInput {
  alertId: string;
  symbol: string;
  token: string | null;
  hitPrice: number;
  scoreBreakdown: unknown;
}

@Injectable()
export class AnandDualTrackService {
  private readonly logger = new Logger(AnandDualTrackService.name);

  constructor(private readonly repo: AnandDualTrackRepository) {}

  async createEntries(input: CreateEntriesInput): Promise<void> {
    const shared = {
      symbol: input.symbol,
      token: input.token,
      entryPrice: input.hitPrice,
      alertId: input.alertId,
      scoreBreakdown: input.scoreBreakdown,
    };

    // Independent guard per track — intraday TRADED entry does NOT block swing
    const [activeIntraday, activeSwing] = await Promise.all([
      this.repo.findActiveTradedBySymbol('intraday', input.symbol),
      this.repo.findActiveTradedBySymbol('swing', input.symbol),
    ]);

    if (activeIntraday) {
      this.logger.log(`[anand] intraday: ${input.symbol} already has active TRADED entry — skipping`);
    } else {
      try {
        await this.repo.createIntradayEntry(shared);
      } catch (err) {
        this.logger.warn(`[anand-dual-track] intraday insert failed for ${input.symbol}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (activeSwing) {
      this.logger.log(`[anand] swing: ${input.symbol} already has active TRADED entry — skipping`);
    } else {
      try {
        await this.repo.createSwingEntry(shared);
      } catch (err) {
        this.logger.warn(`[anand-dual-track] swing insert failed for ${input.symbol}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
