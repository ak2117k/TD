import { Controller, Get, Param, Query, Inject, Optional } from '@nestjs/common';
import { OptionsChainService } from '../services/options-chain.service';
import { GreeksCalculatorService } from '../services/greeks-calculator.service';
import { GetChainDto, GreeksQueryDto } from '../dto/options-chain.dto';
import { BrokerAdapter } from '../../../common/interfaces/broker-adapter.interface';
import { BROKER_ADAPTER_TOKEN } from '../../market-data/services/market-feed.service';

/** Index token map for spot price lookups. */
const INDEX_TOKENS: Record<string, { token: string; exchange: string }> = {
  NIFTY: { token: '99926000', exchange: 'NSE' },
  BANKNIFTY: { token: '99926009', exchange: 'NSE' },
  FINNIFTY: { token: '99926037', exchange: 'NSE' },
  MIDCPNIFTY: { token: '99926074', exchange: 'NSE' },
};

@Controller('api/options')
export class OptionsChainController {
  constructor(
    private readonly optionsChainService: OptionsChainService,
    private readonly greeksCalculator: GreeksCalculatorService,
    @Optional()
    @Inject(BROKER_ADAPTER_TOKEN)
    private readonly brokerAdapter: BrokerAdapter | null,
  ) {}

  /**
   * GET /api/options/chain/:underlying?expiry=2026-03-27
   * Returns the full options chain for the given underlying and expiry.
   */
  @Get('chain/:underlying')
  async getChain(
    @Param('underlying') underlying: string,
    @Query() query: GetChainDto,
  ) {
    let expiry = query.expiry;

    // If no expiry provided, use the nearest available expiry
    if (!expiry) {
      const expiries = await this.optionsChainService.getExpiries(underlying);
      if (expiries.length === 0) {
        return { chain: [], expiry: null, spotPrice: 0 };
      }
      expiry = expiries[0];
    }

    const chain = await this.optionsChainService.getOptionsChain(
      underlying,
      expiry,
    );

    // Fetch spot price for the underlying
    let spotPrice = 0;
    const indexInfo = INDEX_TOKENS[underlying.toUpperCase()];
    if (indexInfo && this.brokerAdapter) {
      try {
        const quote = await this.brokerAdapter.getLiveQuote(
          indexInfo.token,
          indexInfo.exchange,
        );
        spotPrice = quote.ltp;
      } catch {
        // Estimate from chain if live quote fails
      }
    }

    // Fallback: estimate spot from chain (where CE ltp ~ PE ltp)
    if (spotPrice === 0 && chain.length > 0) {
      let closestDiff = Infinity;
      for (const entry of chain) {
        if (entry.ceData && entry.peData && entry.ceData.ltp > 0 && entry.peData.ltp > 0) {
          const diff = Math.abs(entry.ceData.ltp - entry.peData.ltp);
          if (diff < closestDiff) {
            closestDiff = diff;
            spotPrice = entry.strikePrice;
          }
        }
      }
    }

    return {
      chain,
      expiry,
      spotPrice,
      underlying: underlying.toUpperCase(),
    };
  }

  /**
   * GET /api/options/expiries/:underlying
   * Returns all available expiry dates for the underlying.
   */
  @Get('expiries/:underlying')
  async getExpiries(@Param('underlying') underlying: string) {
    const expiries = await this.optionsChainService.getExpiries(underlying);
    return { expiries, underlying: underlying.toUpperCase() };
  }

  /**
   * GET /api/options/analysis/:underlying?expiry=2026-03-27
   * Returns OI analysis: max pain, PCR, OI summary.
   */
  @Get('analysis/:underlying')
  async getAnalysis(
    @Param('underlying') underlying: string,
    @Query() query: GetChainDto,
  ) {
    let expiry = query.expiry;

    if (!expiry) {
      const expiries = await this.optionsChainService.getExpiries(underlying);
      if (expiries.length === 0) {
        return {
          totalCEOI: 0,
          totalPEOI: 0,
          pcr: 0,
          maxPainStrike: 0,
          highestCEOIStrike: 0,
          highestPEOIStrike: 0,
        };
      }
      expiry = expiries[0];
    }

    const chain = await this.optionsChainService.getOptionsChain(
      underlying,
      expiry,
    );

    return this.optionsChainService.getOISummary(chain);
  }

  /**
   * GET /api/options/greeks?spot=22000&strike=22500&expiry=2026-03-27&iv=0.15&type=CE
   * Calculate Greeks for a specific option.
   */
  @Get('greeks')
  calculateGreeks(@Query() query: GreeksQueryDto) {
    const spot = parseFloat(query.spot);
    const strike = parseFloat(query.strike);
    const iv = parseFloat(query.iv);
    const timeToExpiry = this.greeksCalculator.getTimeToExpiry(query.expiry);
    const type = query.type as 'CE' | 'PE';

    const greeks = this.greeksCalculator.calculateGreeks(
      spot,
      strike,
      timeToExpiry,
      0.065,
      iv,
      type,
    );

    const theoreticalPrice = this.greeksCalculator.blackScholesPrice(
      spot,
      strike,
      timeToExpiry,
      0.065,
      iv,
      type,
    );

    return {
      ...greeks,
      theoreticalPrice: Math.round(theoreticalPrice * 100) / 100,
      timeToExpiry: Math.round(timeToExpiry * 10000) / 10000,
    };
  }
}
