import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  BrokerAdapter,
  TickData,
} from '../../../common/interfaces/broker-adapter.interface';
import { BROKER_ADAPTER_TOKEN } from '../../market-data/services/market-feed.service';
import { GreeksCalculatorService } from './greeks-calculator.service';
import { OptionsChainEntry, OptionData, OptionType } from '@td/shared/types';

const DEFAULT_RISK_FREE_RATE = 0.065;

export interface OISummary {
  totalCEOI: number;
  totalPEOI: number;
  pcr: number;
  maxPainStrike: number;
  highestCEOIStrike: number;
  highestPEOIStrike: number;
}

@Injectable()
export class OptionsChainService {
  private readonly logger = new Logger(OptionsChainService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly greeksCalculator: GreeksCalculatorService,
    @Optional()
    @Inject(BROKER_ADAPTER_TOKEN)
    private readonly brokerAdapter: BrokerAdapter | null,
  ) {}

  /**
   * Get available expiry dates for an underlying symbol.
   */
  async getExpiries(underlying: string): Promise<string[]> {
    const instruments = await this.prisma.instrument.findMany({
      where: {
        symbol: { contains: underlying, mode: 'insensitive' },
        segment: 'OPTIONS',
        isActive: true,
        expiry: { not: null },
      },
      select: { expiry: true },
      distinct: ['expiry'],
      orderBy: { expiry: 'asc' },
    });

    return instruments
      .filter((i) => i.expiry !== null && i.expiry >= new Date())
      .map((i) => i.expiry!.toISOString().split('T')[0]);
  }

  /**
   * Build the full options chain for a given underlying and expiry date.
   */
  async getOptionsChain(
    underlying: string,
    expiry: string,
  ): Promise<OptionsChainEntry[]> {
    // 1. Query instruments matching the underlying & expiry in OPTIONS segment
    const expiryStart = new Date(expiry);
    expiryStart.setHours(0, 0, 0, 0);
    const expiryEnd = new Date(expiry);
    expiryEnd.setHours(23, 59, 59, 999);

    const instruments = await this.prisma.instrument.findMany({
      where: {
        symbol: { contains: underlying, mode: 'insensitive' },
        segment: 'OPTIONS',
        isActive: true,
        expiry: {
          gte: expiryStart,
          lte: expiryEnd,
        },
        strike: { not: null },
        optionType: { not: null },
      },
      orderBy: { strike: 'asc' },
    });

    if (instruments.length === 0) {
      return [];
    }

    // 2. Group instruments by strike price
    const strikeMap = new Map<
      number,
      { ce: (typeof instruments)[0] | null; pe: (typeof instruments)[0] | null }
    >();

    for (const inst of instruments) {
      const strike = inst.strike!;
      if (!strikeMap.has(strike)) {
        strikeMap.set(strike, { ce: null, pe: null });
      }
      const entry = strikeMap.get(strike)!;
      if (inst.optionType === OptionType.CE) {
        entry.ce = inst;
      } else if (inst.optionType === OptionType.PE) {
        entry.pe = inst;
      }
    }

    // 3. Get spot price (try live quote, fallback to 0)
    let spotPrice = 0;
    if (this.brokerAdapter) {
      try {
        const quote = await this.brokerAdapter.getLiveQuote(
          underlying,
          'NSE',
        );
        spotPrice = quote.ltp;
      } catch {
        this.logger.warn(
          `Could not get live spot price for ${underlying}, using 0`,
        );
      }
    }

    const timeToExpiry = this.greeksCalculator.getTimeToExpiry(expiryEnd);

    // 4. Build chain entries
    const chain: OptionsChainEntry[] = [];

    for (const [strike, { ce, pe }] of strikeMap) {
      const ceData = ce
        ? await this.buildOptionData(ce, spotPrice, strike, timeToExpiry, 'CE')
        : null;
      const peData = pe
        ? await this.buildOptionData(pe, spotPrice, strike, timeToExpiry, 'PE')
        : null;

      chain.push({
        strikePrice: strike,
        expiryDate: expiry,
        ceData,
        peData,
      });
    }

    // Sort by strike price ascending
    chain.sort((a, b) => a.strikePrice - b.strikePrice);

    return chain;
  }

  /**
   * Calculate max pain strike — the strike where total loss for option writers is minimized.
   */
  getMaxPain(chain: OptionsChainEntry[]): number {
    if (chain.length === 0) return 0;

    const strikes = chain.map((e) => e.strikePrice);
    let minPain = Infinity;
    let maxPainStrike = strikes[0];

    for (const testStrike of strikes) {
      let totalPain = 0;

      for (const entry of chain) {
        // CE writers' loss if expiry at testStrike
        if (entry.ceData && testStrike > entry.strikePrice) {
          totalPain +=
            (testStrike - entry.strikePrice) * entry.ceData.oi;
        }
        // PE writers' loss if expiry at testStrike
        if (entry.peData && testStrike < entry.strikePrice) {
          totalPain +=
            (entry.strikePrice - testStrike) * entry.peData.oi;
        }
      }

      if (totalPain < minPain) {
        minPain = totalPain;
        maxPainStrike = testStrike;
      }
    }

    return maxPainStrike;
  }

  /**
   * Calculate Put/Call ratio based on OI.
   */
  getPCR(chain: OptionsChainEntry[]): number {
    let totalCEOI = 0;
    let totalPEOI = 0;

    for (const entry of chain) {
      if (entry.ceData) totalCEOI += entry.ceData.oi;
      if (entry.peData) totalPEOI += entry.peData.oi;
    }

    if (totalCEOI === 0) return 0;
    return Math.round((totalPEOI / totalCEOI) * 100) / 100;
  }

  /**
   * Get full OI analysis summary.
   */
  getOISummary(chain: OptionsChainEntry[]): OISummary {
    let totalCEOI = 0;
    let totalPEOI = 0;
    let highestCEOI = 0;
    let highestPEOI = 0;
    let highestCEOIStrike = 0;
    let highestPEOIStrike = 0;

    for (const entry of chain) {
      if (entry.ceData) {
        totalCEOI += entry.ceData.oi;
        if (entry.ceData.oi > highestCEOI) {
          highestCEOI = entry.ceData.oi;
          highestCEOIStrike = entry.strikePrice;
        }
      }
      if (entry.peData) {
        totalPEOI += entry.peData.oi;
        if (entry.peData.oi > highestPEOI) {
          highestPEOI = entry.peData.oi;
          highestPEOIStrike = entry.strikePrice;
        }
      }
    }

    const pcr = totalCEOI === 0 ? 0 : Math.round((totalPEOI / totalCEOI) * 100) / 100;
    const maxPainStrike = this.getMaxPain(chain);

    return {
      totalCEOI,
      totalPEOI,
      pcr,
      maxPainStrike,
      highestCEOIStrike,
      highestPEOIStrike,
    };
  }

  /**
   * Build OptionData for a single instrument (CE or PE).
   */
  private async buildOptionData(
    instrument: {
      token: string;
      symbol: string;
      exchange: string;
    },
    spotPrice: number,
    strikePrice: number,
    timeToExpiry: number,
    optionType: 'CE' | 'PE',
  ): Promise<OptionData> {
    let ltp = 0;
    let oi = 0;
    let oiChange = 0;
    let volume = 0;
    let bidPrice = 0;
    let askPrice = 0;

    // Try to get live data from broker
    if (this.brokerAdapter) {
      try {
        const quote = await this.brokerAdapter.getLiveQuote(
          instrument.token,
          instrument.exchange,
        );
        ltp = quote.ltp;
        volume = quote.volume;
      } catch {
        // Use defaults
      }
    }

    // Get latest OI from database
    try {
      const latestOI = await this.prisma.oISnapshot.findFirst({
        where: {
          instrument: { token: instrument.token },
        },
        orderBy: { timestamp: 'desc' },
      });

      if (latestOI) {
        oi = Number(latestOI.oi);
        oiChange = Number(latestOI.oiChange);
      }
    } catch {
      // Use defaults
    }

    // Calculate IV from the market price
    let iv = 0;
    if (ltp > 0 && spotPrice > 0 && timeToExpiry > 0) {
      iv = this.greeksCalculator.calculateIV(
        ltp,
        spotPrice,
        strikePrice,
        timeToExpiry,
        DEFAULT_RISK_FREE_RATE,
        optionType,
      );
    }

    // Calculate Greeks
    const greeks =
      iv > 0 && spotPrice > 0 && timeToExpiry > 0
        ? this.greeksCalculator.calculateGreeks(
            spotPrice,
            strikePrice,
            timeToExpiry,
            DEFAULT_RISK_FREE_RATE,
            iv,
            optionType,
          )
        : { delta: 0, gamma: 0, theta: 0, vega: 0 };

    return {
      ltp,
      oi,
      oiChange,
      volume,
      iv: Math.round(iv * 10000) / 100, // Convert to percentage
      delta: greeks.delta,
      gamma: greeks.gamma,
      theta: greeks.theta,
      vega: greeks.vega,
      bidPrice,
      askPrice,
    };
  }
}
