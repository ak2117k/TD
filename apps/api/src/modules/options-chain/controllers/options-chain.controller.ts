import { Controller, Get, Param, Query } from '@nestjs/common';
import { OptionsChainService } from '../services/options-chain.service';
import { GreeksCalculatorService } from '../services/greeks-calculator.service';
import { GetChainDto, GreeksQueryDto } from '../dto/options-chain.dto';

@Controller('options')
export class OptionsChainController {
  constructor(
    private readonly optionsChainService: OptionsChainService,
    private readonly greeksCalculator: GreeksCalculatorService,
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

    return {
      chain,
      expiry,
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
