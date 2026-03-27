import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TradingStrategy } from '../../../common/interfaces/trading-strategy.interface';
import { SettingsService } from '../../settings/services/settings.service';

@Injectable()
export class StrategyRegistryService implements OnModuleInit {
  private readonly logger = new Logger(StrategyRegistryService.name);
  private readonly strategies = new Map<string, TradingStrategy>();

  constructor(private readonly settingsService: SettingsService) {}

  async onModuleInit(): Promise<void> {
    this.logger.log(
      `Strategy registry initialized with ${this.strategies.size} strategies`,
    );
  }

  /**
   * Register a trading strategy in the registry.
   */
  register(strategy: TradingStrategy): void {
    if (this.strategies.has(strategy.name)) {
      this.logger.warn(
        `Strategy "${strategy.name}" is already registered — overwriting`,
      );
    }
    this.strategies.set(strategy.name, strategy);
    this.logger.log(
      `Registered strategy: ${strategy.name} (segments: ${strategy.supportedSegments.join(', ')})`,
    );
  }

  /**
   * Remove a strategy from the registry.
   */
  unregister(name: string): boolean {
    const removed = this.strategies.delete(name);
    if (removed) {
      this.logger.log(`Unregistered strategy: ${name}`);
    }
    return removed;
  }

  /**
   * Get a strategy by name.
   */
  getStrategy(name: string): TradingStrategy | undefined {
    return this.strategies.get(name);
  }

  /**
   * Get all strategies that are in the user's activeStrategies setting.
   */
  async getActiveStrategies(): Promise<TradingStrategy[]> {
    const settings = await this.settingsService.getSettings();
    const activeNames: string[] = settings.activeStrategies ?? [];

    const active: TradingStrategy[] = [];
    for (const name of activeNames) {
      const strategy = this.strategies.get(name);
      if (strategy) {
        active.push(strategy);
      } else {
        this.logger.warn(
          `Active strategy "${name}" is not registered in the registry`,
        );
      }
    }

    return active;
  }

  /**
   * List all registered strategies with metadata.
   */
  getAllStrategies(): Array<{
    name: string;
    description: string;
    supportedSegments: string[];
    preferredTimeframes: string[];
    parameters: Record<string, any>;
  }> {
    return Array.from(this.strategies.values()).map((s) => ({
      name: s.name,
      description: s.description,
      supportedSegments: s.supportedSegments,
      preferredTimeframes: s.preferredTimeframes,
      parameters: s.getParameters(),
    }));
  }
}
