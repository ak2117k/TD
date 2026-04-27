// Pure indicator math for the levels-context confluence layer.
// Self-contained — no external libs, no NestJS imports. Each function
// returns the LATEST reading from the input series, or null if the
// series is too short. Callers pass close-price arrays.

export function ema(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const k = 2 / (period + 1);
  // Seed EMA with the SMA of the first `period` values — standard
  // convention; avoids the bias of seeding with the first close alone.
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

export function rsi(closes: number[], period = 14): number | null {
  if (period <= 0 || closes.length < period + 1) return null;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum += -diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  // Wilder smoothing for the rest of the series.
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { macd: number; signal: number; histogram: number } | null {
  if (closes.length < slow + signal) return null;
  // Build the MACD line as a series so we can EMA it for the signal line.
  const k = (p: number) => 2 / (p + 1);
  const seedSma = (p: number) => {
    let s = 0;
    for (let i = 0; i < p; i++) s += closes[i];
    return s / p;
  };
  // Build EMA series starting at index `period - 1`.
  const buildEma = (p: number): number[] => {
    const out: number[] = [];
    let prev = seedSma(p);
    out.push(prev);
    const kk = k(p);
    for (let i = p; i < closes.length; i++) {
      prev = closes[i] * kk + prev * (1 - kk);
      out.push(prev);
    }
    return out;
  };
  const fastEma = buildEma(fast); // length = closes.length - fast + 1
  const slowEma = buildEma(slow); // length = closes.length - slow + 1
  // Align: fastEma is `slow - fast` entries longer at the start.
  const offset = slow - fast;
  const macdLine: number[] = [];
  for (let i = 0; i < slowEma.length; i++) {
    macdLine.push(fastEma[i + offset] - slowEma[i]);
  }
  if (macdLine.length < signal) return null;
  // Signal = EMA(signal) of the MACD line.
  let sig = 0;
  for (let i = 0; i < signal; i++) sig += macdLine[i];
  sig /= signal;
  const ks = k(signal);
  for (let i = signal; i < macdLine.length; i++) {
    sig = macdLine[i] * ks + sig * (1 - ks);
  }
  const macdNow = macdLine[macdLine.length - 1];
  return { macd: macdNow, signal: sig, histogram: macdNow - sig };
}

export function bollinger(
  closes: number[],
  period = 20,
  stdDev = 2,
): { upper: number; middle: number; lower: number } | null {
  if (period <= 0 || closes.length < period) return null;
  const window = closes.slice(closes.length - period);
  let sum = 0;
  for (const v of window) sum += v;
  const mean = sum / period;
  let varSum = 0;
  for (const v of window) {
    const d = v - mean;
    varSum += d * d;
  }
  const sd = Math.sqrt(varSum / period);
  return { upper: mean + stdDev * sd, middle: mean, lower: mean - stdDev * sd };
}

export function roc(closes: number[], period = 10): number | null {
  if (period <= 0 || closes.length <= period) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - period];
  if (then === 0) return null;
  return ((now - then) / then) * 100;
}
