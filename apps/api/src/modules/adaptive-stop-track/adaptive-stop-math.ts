import { ATR_MULT, MIN_STOP_PCT, MAX_STOP_PCT, RISK_PER_TRADE } from './constants';

export interface StopResolution { stopPrice: number; stopDist: number; stopPct: number; basis: 'atr' | 'floor' | 'cap'; }

/** Volatility stop: ATR_MULT×atr5m, floored at MIN_STOP_PCT and capped at MAX_STOP_PCT of entry. */
export function resolveStop(entry: number, atr5m: number): StopResolution {
  const minDist = (MIN_STOP_PCT / 100) * entry;
  const maxDist = (MAX_STOP_PCT / 100) * entry;
  const atrDist = Number.isFinite(atr5m) && atr5m > 0 ? ATR_MULT * atr5m : 0;
  let stopDist = atrDist;
  let basis: StopResolution['basis'] = 'atr';
  if (!(atrDist > 0) || atrDist < minDist) { stopDist = minDist; basis = 'floor'; }
  else if (atrDist > maxDist) { stopDist = maxDist; basis = 'cap'; }
  return { stopPrice: entry - stopDist, stopDist, stopPct: (stopDist / entry) * 100, basis };
}

/** Risk-first sizing: take only as many shares as keep the loss-at-stop = RISK_PER_TRADE. */
export function sizeQuantity(stopDist: number): number {
  if (!(stopDist > 0)) return 0;
  return Math.floor(RISK_PER_TRADE / stopDist);
}
