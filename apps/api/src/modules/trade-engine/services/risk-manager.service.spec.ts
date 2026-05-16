import { Test } from '@nestjs/testing';
import { RiskManagerService } from './risk-manager.service';
import { SettingsService } from '../../settings/services/settings.service';
import { TradeRepository } from '../repositories/trade.repository';
import { PaperTradeService } from './paper-trade.service';

describe('RiskManagerService.getDailyRiskStatus', () => {
  it('reports capitalDeployed as the summed entry value of open trades', async () => {
    // Regression: capitalDeployed was read from an in-memory counter that
    // only advanced as a side effect of a matching market tick — so it sat
    // at ₹0 even with open positions. It must be derived from the open
    // trades the method already fetches (consistent with positionsUsed).
    const openTrades = [
      { entryPrice: 1000, quantity: 10 }, // ₹10,000
      { entryPrice: 250.5, quantity: 4 }, // ₹1,002
    ];
    const mod = await Test.createTestingModule({
      providers: [
        RiskManagerService,
        {
          provide: SettingsService,
          useValue: {
            getSettings: jest.fn().mockResolvedValue({
              maxDailyLoss: 5000,
              maxConcurrentPositions: 10,
              maxCapitalPerTrade: 200000,
            }),
          },
        },
        {
          provide: TradeRepository,
          useValue: {
            getDailyPnL: jest.fn().mockResolvedValue(0),
            getOpenTrades: jest.fn().mockResolvedValue(openTrades),
          },
        },
        {
          provide: PaperTradeService,
          useValue: { getVirtualBalance: jest.fn().mockReturnValue(2_000_000) },
        },
      ],
    }).compile();
    const svc = mod.get(RiskManagerService);

    const status = await svc.getDailyRiskStatus();

    expect(status.capitalDeployed).toBe(1000 * 10 + 250.5 * 4);
  });
});
