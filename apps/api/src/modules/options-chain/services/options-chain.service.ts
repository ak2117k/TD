import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  BrokerAdapter,
  TickData,
} from '../../../common/interfaces/broker-adapter.interface';
import { BROKER_ADAPTER_TOKEN } from '../../market-data/services/market-feed.service';
import { AngelOneAuthService } from '../../market-data/services/angel-one-auth.service';
import { GreeksCalculatorService } from './greeks-calculator.service';
import { OptionsChainEntry, OptionData, OptionType } from '@td/shared/types';

const DEFAULT_RISK_FREE_RATE = 0.065;

/**
 * In-memory cache for option contracts fetched from the Angel One master list.
 * Keyed by uppercase underlying (e.g., "NIFTY").
 * Expires after CACHE_TTL_MS to ensure we pick up new expiries.
 */
interface CachedContracts {
  contracts: OptionContract[];
  fetchedAt: number;
}

interface OptionContract {
  token: string;
  symbol: string;
  name: string;
  exchange: string;
  expiry: Date;
  strike: number;
  optionType: 'CE' | 'PE';
  lotSize: number;
}

/** Cache TTL: 30 minutes */
const CACHE_TTL_MS = 30 * 60 * 1000;

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

  /** In-memory cache for option contracts by underlying. */
  private contractsCache = new Map<string, CachedContracts>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly greeksCalculator: GreeksCalculatorService,
    @Optional()
    @Inject(BROKER_ADAPTER_TOKEN)
    private readonly brokerAdapter: BrokerAdapter | null,
    private readonly authService: AngelOneAuthService,
  ) {}

  /**
   * Get available expiry dates for an underlying symbol.
   * Tries DB first, falls back to fetching from Angel One instrument master.
   */
  async getExpiries(underlying: string): Promise<string[]> {
    // 1. Try database first
    const dbExpiries = await this.getExpiriesFromDB(underlying);
    if (dbExpiries.length > 0) {
      return dbExpiries;
    }

    // 2. Fall back to Angel One instrument master
    const contracts = await this.getOptionContracts(underlying);
    if (contracts.length === 0) {
      return [];
    }

    // Extract unique expiry dates, filter to future dates, sort ascending
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const expirySet = new Set<string>();
    for (const c of contracts) {
      if (c.expiry >= now) {
        expirySet.add(c.expiry.toISOString().split('T')[0]);
      }
    }

    const expiries = Array.from(expirySet).sort();
    this.logger.log(
      `Found ${expiries.length} expiries for ${underlying} from instrument master`,
    );

    return expiries;
  }

  /**
   * Build the full options chain for a given underlying and expiry date.
   * Uses DB instruments if available, otherwise fetches from Angel One master.
   */
  async getOptionsChain(
    underlying: string,
    expiry: string,
  ): Promise<OptionsChainEntry[]> {
    // 1. Try database instruments first
    const dbChain = await this.getChainFromDB(underlying, expiry);
    if (dbChain.length > 0) {
      return dbChain;
    }

    // 2. Fall back to Angel One instrument master
    return this.getChainFromMaster(underlying, expiry);
  }

  /**
   * Calculate max pain strike -- the strike where total loss for option writers is minimized.
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

    const pcr =
      totalCEOI === 0
        ? 0
        : Math.round((totalPEOI / totalCEOI) * 100) / 100;
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

  // ─────────────────────────────────────────────────────
  // Private: DB-backed methods (original approach)
  // ─────────────────────────────────────────────────────

  private async getExpiriesFromDB(underlying: string): Promise<string[]> {
    try {
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
    } catch {
      return [];
    }
  }

  private async getChainFromDB(
    underlying: string,
    expiry: string,
  ): Promise<OptionsChainEntry[]> {
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

    // Group instruments by strike price
    const strikeMap = new Map<
      number,
      {
        ce: (typeof instruments)[0] | null;
        pe: (typeof instruments)[0] | null;
      }
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

    // Get spot price
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

    // Build chain entries
    const chain: OptionsChainEntry[] = [];
    for (const [strike, { ce, pe }] of strikeMap) {
      const ceData = ce
        ? await this.buildOptionDataFromDB(
            ce,
            spotPrice,
            strike,
            timeToExpiry,
            'CE',
          )
        : null;
      const peData = pe
        ? await this.buildOptionDataFromDB(
            pe,
            spotPrice,
            strike,
            timeToExpiry,
            'PE',
          )
        : null;

      chain.push({ strikePrice: strike, expiryDate: expiry, ceData, peData });
    }

    chain.sort((a, b) => a.strikePrice - b.strikePrice);
    return chain;
  }

  // ─────────────────────────────────────────────────────
  // Private: Angel One master-backed methods (dynamic)
  // ─────────────────────────────────────────────────────

  /**
   * Get option contracts from the Angel One instrument master,
   * using in-memory cache with TTL.
   */
  private async getOptionContracts(
    underlying: string,
  ): Promise<OptionContract[]> {
    const key = underlying.toUpperCase();
    const cached = this.contractsCache.get(key);

    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.contracts;
    }

    if (!this.brokerAdapter || !this.brokerAdapter.getOptionContracts) {
      this.logger.warn(
        'Broker adapter unavailable or does not support getOptionContracts',
      );
      return [];
    }

    try {
      const contracts =
        await this.brokerAdapter.getOptionContracts(underlying);

      this.contractsCache.set(key, {
        contracts,
        fetchedAt: Date.now(),
      });

      return contracts;
    } catch (error) {
      this.logger.error(
        `Failed to fetch option contracts for ${underlying}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return [];
    }
  }

  /**
   * Build the options chain using Angel One's optionGreek API.
   * This returns the full chain with LTP, OI, Greeks in a single API call.
   */
  private async getChainFromMaster(
    underlying: string,
    expiry: string,
  ): Promise<OptionsChainEntry[]> {
    if (!this.brokerAdapter) {
      this.logger.warn('No broker adapter — cannot build options chain');
      return [];
    }

    // Get spot price
    const indexTokens: Record<string, { token: string; exchange: string }> = {
      NIFTY: { token: '99926000', exchange: 'NSE' },
      BANKNIFTY: { token: '99926009', exchange: 'NSE' },
      FINNIFTY: { token: '99926037', exchange: 'NSE' },
      MIDCPNIFTY: { token: '99926074', exchange: 'NSE' },
    };

    let spotPrice = 0;
    const indexInfo = indexTokens[underlying.toUpperCase()];
    if (indexInfo) {
      try {
        const quote = await this.brokerAdapter.getLiveQuote(indexInfo.token, indexInfo.exchange);
        spotPrice = quote.ltp;
      } catch {
        this.logger.warn(`Could not get spot price for ${underlying}`);
      }
    }

    // Format expiry as DDMMMYYYY for Angel One API (e.g., "03APR2026")
    const expiryDate = new Date(expiry);
    const day = String(expiryDate.getDate()).padStart(2, '0');
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const mon = months[expiryDate.getMonth()];
    const year = expiryDate.getFullYear();
    const expiryTag = `${day}${mon}${year}`;

    this.logger.log(
      `Fetching option chain via optionGreek API: ${underlying} ${expiryTag}`,
    );

    try {
      // Use Angel One's optionGreek API — returns full chain in one call
      if (!this.authService.isAuthenticated()) {
        this.logger.warn('AngelOneAuthService not available or not authenticated — cannot call optionGreek');
        return this.buildSyntheticChain(underlying, expiry, spotPrice);
      }
      const smartApi = this.authService.getSmartApi();
      if (!smartApi?.optionGreek) {
        this.logger.warn('optionGreek API not available on SmartAPI instance');
        return this.buildSyntheticChain(underlying, expiry, spotPrice);
      }

      const response = await smartApi.optionGreek({
        name: underlying.toUpperCase(),
        expirydate: expiryTag,
      });

      this.logger.debug(`optionGreek raw response status: ${response?.status}, message: ${response?.message}`);

      // Angel One may return data directly or nested under response.data
      const rawData = response?.data;
      if (!rawData || !Array.isArray(rawData) || rawData.length === 0) {
        this.logger.warn(
          `optionGreek returned no data for ${underlying} ${expiryTag}. ` +
          `Response: ${JSON.stringify({ status: response?.status, message: response?.message, dataType: typeof rawData, dataIsArray: Array.isArray(rawData) })}`,
        );
        return this.buildSyntheticChain(underlying, expiry, spotPrice);
      }

      // Log first contract keys for debugging field names
      this.logger.debug(`optionGreek sample contract keys: ${Object.keys(rawData[0]).join(', ')}`);
      this.logger.log(`optionGreek returned ${rawData.length} contracts`);

      // Group by strike price
      const strikeMap = new Map<number, { ce: any; pe: any }>();

      for (const contract of rawData) {
        const strike = Number(
          contract.strikePrice ?? contract.strikeprice ?? contract.strike_price ?? 0,
        );
        if (strike <= 0) continue;

        if (!strikeMap.has(strike)) {
          strikeMap.set(strike, { ce: null, pe: null });
        }
        const entry = strikeMap.get(strike)!;
        const optType = (
          contract.optionType ?? contract.option_type ?? contract.opttype ?? ''
        ).toUpperCase();
        if (optType === 'CE') entry.ce = contract;
        else if (optType === 'PE') entry.pe = contract;
      }

      const expiryEnd = new Date(expiry);
      expiryEnd.setHours(15, 30, 0, 0);
      const timeToExpiry = this.greeksCalculator.getTimeToExpiry(expiryEnd);

      // Build chain entries
      const chain: OptionsChainEntry[] = [];
      for (const [strike, { ce, pe }] of strikeMap) {
        chain.push({
          strikePrice: strike,
          expiryDate: expiry,
          ceData: ce ? this.mapOptionGreekData(ce, spotPrice, strike, timeToExpiry, 'CE') : null,
          peData: pe ? this.mapOptionGreekData(pe, spotPrice, strike, timeToExpiry, 'PE') : null,
        });
      }

      chain.sort((a, b) => a.strikePrice - b.strikePrice);

      // Limit to ±20 strikes around ATM
      if (spotPrice > 0 && chain.length > 40) {
        let atmIdx = 0;
        let minDiff = Infinity;
        for (let i = 0; i < chain.length; i++) {
          const diff = Math.abs(chain[i].strikePrice - spotPrice);
          if (diff < minDiff) { minDiff = diff; atmIdx = i; }
        }
        const start = Math.max(0, atmIdx - 20);
        const end = Math.min(chain.length, atmIdx + 21);
        const trimmed = chain.slice(start, end);
        this.logger.log(`Options chain: ${trimmed.length} strikes around ATM ${spotPrice}`);
        return trimmed;
      }

      this.logger.log(`Options chain: ${chain.length} strikes, spot=${spotPrice}`);
      return chain;
    } catch (error) {
      this.logger.warn(
        `optionGreek API failed: ${error instanceof Error ? error.message : error}. Using synthetic chain.`,
      );
      return this.buildSyntheticChain(underlying, expiry, spotPrice);
    }
  }

  /**
   * Map a single contract from optionGreek API response to our OptionData format.
   */
  private mapOptionGreekData(
    contract: any,
    spotPrice: number,
    strike: number,
    timeToExpiry: number,
    optionType: 'CE' | 'PE',
  ): OptionData {
    const ltp = Number(contract.ltp ?? contract.lastPrice ?? 0);
    const oi = Number(contract.openInterest ?? contract.opnInterest ?? contract.oi ?? 0);
    const oiChange = Number(contract.oiChange ?? contract.changeinOpenInterest ?? 0);
    const volume = Number(contract.totalTradedVolume ?? contract.volume ?? 0);
    const iv = Number(contract.impliedVolatility ?? contract.iv ?? 0);
    const delta = Number(contract.delta ?? 0);
    const gamma = Number(contract.gamma ?? 0);
    const theta = Number(contract.theta ?? 0);
    const vega = Number(contract.vega ?? 0);
    const bidPrice = Number(contract.bidprice ?? contract.bidPrice ?? 0);
    const askPrice = Number(contract.askprice ?? contract.askPrice ?? 0);

    // If optionGreek provides Greeks directly, use them; otherwise compute
    if (iv > 0 || delta !== 0) {
      return { ltp, oi, oiChange, volume, iv, delta, gamma, theta, vega, bidPrice, askPrice };
    }

    return this.computeGreeksAndIV(
      ltp, oi, oiChange, volume, bidPrice, askPrice,
      spotPrice, strike, timeToExpiry, optionType,
    );
  }

  /**
   * Build a synthetic chain with theoretical values when live data is unavailable.
   * Uses Black-Scholes to compute approximate option prices.
   */
  private buildSyntheticChain(
    underlying: string,
    expiry: string,
    spotPrice: number,
  ): OptionsChainEntry[] {
    if (spotPrice === 0) return [];

    const strikeIntervals: Record<string, number> = {
      NIFTY: 50, BANKNIFTY: 100, FINNIFTY: 50, MIDCPNIFTY: 25,
    };
    const interval = strikeIntervals[underlying.toUpperCase()] ?? 50;
    const atmStrike = Math.round(spotPrice / interval) * interval;

    const expiryEnd = new Date(expiry);
    expiryEnd.setHours(15, 30, 0, 0);
    const timeToExpiry = this.greeksCalculator.getTimeToExpiry(expiryEnd);
    const defaultIV = 0.15; // 15% assumed IV

    const chain: OptionsChainEntry[] = [];
    for (let i = -10; i <= 10; i++) {
      const strike = atmStrike + i * interval;
      const ceGreeks = this.greeksCalculator.calculateGreeks(
        spotPrice, strike, timeToExpiry, DEFAULT_RISK_FREE_RATE, defaultIV, 'CE',
      );
      const peGreeks = this.greeksCalculator.calculateGreeks(
        spotPrice, strike, timeToExpiry, DEFAULT_RISK_FREE_RATE, defaultIV, 'PE',
      );
      const cePrice = this.greeksCalculator.blackScholesPrice(
        spotPrice, strike, timeToExpiry, DEFAULT_RISK_FREE_RATE, defaultIV, 'CE',
      );
      const pePrice = this.greeksCalculator.blackScholesPrice(
        spotPrice, strike, timeToExpiry, DEFAULT_RISK_FREE_RATE, defaultIV, 'PE',
      );

      chain.push({
        strikePrice: strike,
        expiryDate: expiry,
        ceData: {
          ltp: Math.round(cePrice * 100) / 100,
          oi: 0, oiChange: 0, volume: 0,
          iv: defaultIV * 100,
          ...ceGreeks,
          bidPrice: 0, askPrice: 0,
        },
        peData: {
          ltp: Math.round(pePrice * 100) / 100,
          oi: 0, oiChange: 0, volume: 0,
          iv: defaultIV * 100,
          ...peGreeks,
          bidPrice: 0, askPrice: 0,
        },
      });
    }

    this.logger.log(`Built synthetic chain: ${chain.length} strikes, spot=${spotPrice}`);
    return chain;
  }

  // ─────────────────────────────────────────────────────
  // Private: Build OptionData for a single contract
  // ─────────────────────────────────────────────────────

  /**
   * Build OptionData from a DB instrument record.
   */
  private async buildOptionDataFromDB(
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
    const bidPrice = 0;
    const askPrice = 0;

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

    return this.computeGreeksAndIV(
      ltp,
      oi,
      oiChange,
      volume,
      bidPrice,
      askPrice,
      spotPrice,
      strikePrice,
      timeToExpiry,
      optionType,
    );
  }

  /**
   * Build OptionData from an Angel One master contract (dynamic discovery).
   */
  private async buildOptionDataFromMaster(
    contract: OptionContract,
    spotPrice: number,
    strikePrice: number,
    timeToExpiry: number,
    optionType: 'CE' | 'PE',
  ): Promise<OptionData> {
    let ltp = 0;
    let oi = 0;
    let oiChange = 0;
    let volume = 0;
    const bidPrice = 0;
    const askPrice = 0;

    // Fetch live quote from Angel One using the contract token
    if (this.brokerAdapter) {
      try {
        const quote = await this.brokerAdapter.getLiveQuote(
          contract.token,
          contract.exchange,
        );
        ltp = quote.ltp;
        volume = quote.volume;
        // Angel One FULL mode returns OI in the response
        if ((quote as any).oi != null) {
          oi = Number((quote as any).oi);
        }
      } catch (err) {
        this.logger.debug(
          `Could not get live quote for ${contract.symbol}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }

    return this.computeGreeksAndIV(
      ltp,
      oi,
      oiChange,
      volume,
      bidPrice,
      askPrice,
      spotPrice,
      strikePrice,
      timeToExpiry,
      optionType,
    );
  }

  /**
   * Shared helper: compute IV and Greeks from raw market data.
   */
  private computeGreeksAndIV(
    ltp: number,
    oi: number,
    oiChange: number,
    volume: number,
    bidPrice: number,
    askPrice: number,
    spotPrice: number,
    strikePrice: number,
    timeToExpiry: number,
    optionType: 'CE' | 'PE',
  ): OptionData {
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
