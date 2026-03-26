import {
  MARKET_OPEN_HOUR,
  MARKET_OPEN_MINUTE,
  MARKET_CLOSE_HOUR,
  MARKET_CLOSE_MINUTE,
} from '../constants';

/**
 * Check if Indian equity market is currently open (IST)
 */
export function isMarketOpen(): boolean {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset + now.getTimezoneOffset() * 60 * 1000);

  const day = ist.getDay();
  if (day === 0 || day === 6) return false; // Weekend

  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const currentMinutes = hours * 60 + minutes;
  const openMinutes = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MINUTE;
  const closeMinutes = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MINUTE;

  return currentMinutes >= openMinutes && currentMinutes <= closeMinutes;
}

/**
 * Calculate risk/reward ratio
 */
export function calculateRiskReward(
  entry: number,
  target: number,
  stoploss: number,
): number {
  const risk = Math.abs(entry - stoploss);
  const reward = Math.abs(target - entry);
  return risk > 0 ? Number((reward / risk).toFixed(2)) : 0;
}

/**
 * Calculate position size based on risk
 */
export function calculatePositionSize(
  capital: number,
  riskPercent: number,
  entryPrice: number,
  stoplossPrice: number,
): number {
  const riskAmount = capital * (riskPercent / 100);
  const riskPerUnit = Math.abs(entryPrice - stoplossPrice);
  return riskPerUnit > 0 ? Math.floor(riskAmount / riskPerUnit) : 0;
}

/**
 * Format INR currency
 */
export function formatINR(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Calculate percentage change
 */
export function percentChange(current: number, previous: number): number {
  if (previous === 0) return 0;
  return Number((((current - previous) / previous) * 100).toFixed(2));
}
