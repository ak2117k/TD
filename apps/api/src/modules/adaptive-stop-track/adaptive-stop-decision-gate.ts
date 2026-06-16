/**
 * Decision Gate (CORE2) — the post-score structural filter for the adaptive-stop
 * track. The score gate proved non-predictive (it rewards extension; 70+ scores
 * won only 33%). This gate adds the read an experienced trader actually makes:
 * take the entry ONLY if price is (a) AT support and (b) NOT extended.
 *
 * Validated on the track's own history (≈102 trades): the two-rule core kept 35
 * trades at 57% win / +₹252 per trade, and FORWARD-VALIDATED on a chronological
 * holdout — in a held-out period where the ungated baseline lost (31% win,
 * −₹5,075), gated entries were 50% win / +₹373 per trade.
 *
 * Pure + deterministic so it unit-tests in isolation; the service fetches the
 * candles and calls evaluateDecisionGate().
 */

export interface GateCandle {
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: string | Date;
}

export interface GateParams {
  /** Max % above the nearest support level to still count as "at support". */
  nearSupportPct: number;
  /** RSI(15m) at/above this = extended (chasing). */
  rsiHot: number;
  /** Entry more than this % above session VWAP = extended (chasing). */
  vwapExtPct: number;
}

export interface DecisionGateResult {
  pass: boolean;
  /** True when the gate couldn't evaluate (too few candles) — caller fails OPEN. */
  skipped: boolean;
  nearSupport: boolean;
  notExtended: boolean;
  reason: string;
  detail: {
    nearestSupport: number | null;
    distSupportPct: number | null;
    rsi: number | null;
    vwapExtPct: number | null;
  };
}

const ms = (c: GateCandle): number => new Date(c.timestamp).getTime();
const istDateKey = (epochMs: number): string =>
  new Date(epochMs).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/**
 * 3-bar fractal swing pivots — byte-for-byte the same rule the chart's S/R
 * engine uses (signal-generator/services/swing-pivots.ts). Swing highs are
 * resistance, swing lows are support.
 */
export function detectSwingPivots(candles: GateCandle[]): { price: number; kind: 'high' | 'low' }[] {
  const out: { price: number; kind: 'high' | 'low' }[] = [];
  for (let i = 3; i < candles.length - 3; i++) {
    const c = candles[i];
    if (
      c.high > candles[i - 1].high && c.high > candles[i - 2].high && c.high > candles[i - 3].high &&
      c.high > candles[i + 1].high && c.high > candles[i + 2].high && c.high > candles[i + 3].high
    ) { out.push({ price: c.high, kind: 'high' }); continue; }
    if (
      c.low < candles[i - 1].low && c.low < candles[i - 2].low && c.low < candles[i - 3].low &&
      c.low < candles[i + 1].low && c.low < candles[i + 2].low && c.low < candles[i + 3].low
    ) { out.push({ price: c.low, kind: 'low' }); }
  }
  return out;
}

/** Price-adaptive round-number step (mirrors adaptive-round-numbers.ts). */
export function adaptiveRoundStep(ltp: number): number {
  if (ltp < 50) return 1;
  if (ltp < 200) return 5;
  if (ltp < 500) return 10;
  if (ltp < 2000) return 25;
  if (ltp < 5000) return 50;
  return 100;
}

/** ±3 adaptive round numbers around price. */
export function roundGrid(ltp: number): number[] {
  if (!(ltp > 0)) return [];
  const step = adaptiveRoundStep(ltp);
  const center = Math.round(ltp / step) * step;
  const out: number[] = [];
  for (let k = -3; k <= 3; k++) out.push(center + k * step);
  return out;
}

/** Wilder RSI; null when fewer than period+1 closes. */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

/**
 * Evaluate the CORE2 gate. `candles15m` is a multi-day 15m series; `nowMs` is
 * the entry moment. Only candles fully closed before `nowMs` are used — no
 * look-ahead. Returns `skipped:true, pass:true` when there isn't enough data to
 * judge, so the caller fails OPEN (a data gap never suppresses an entry).
 */
export function evaluateDecisionGate(
  entry: number,
  candles15m: GateCandle[],
  nowMs: number,
  p: GateParams,
): DecisionGateResult {
  const empty = { nearestSupport: null, distSupportPct: null, rsi: null, vwapExtPct: null };
  if (!(entry > 0) || !Array.isArray(candles15m)) {
    return { pass: true, skipped: true, nearSupport: false, notExtended: false, reason: 'no-candles (gate skipped)', detail: empty };
  }
  const before = candles15m.filter((c) => ms(c) + 15 * 60_000 <= nowMs);
  const dayKey = istDateKey(nowMs);
  const sameDay = before.filter((c) => istDateKey(ms(c)) === dayKey);
  if (before.length < 10 || sameDay.length < 3) {
    return { pass: true, skipped: true, nearSupport: false, notExtended: false, reason: 'insufficient-candles (gate skipped)', detail: empty };
  }

  // --- Rule: AT SUPPORT (multi-day swing-low pivots + round numbers below) ---
  const pivots = detectSwingPivots(before);
  const supports = [
    ...pivots.filter((x) => x.kind === 'low').map((x) => x.price),
    ...roundGrid(entry),
  ].filter((price) => price < entry * 0.9995);
  const nearestSupport = supports.length ? Math.max(...supports) : null;
  const distSupportPct = nearestSupport != null ? ((entry - nearestSupport) / entry) * 100 : null;
  const nearSupport = distSupportPct != null && distSupportPct <= p.nearSupportPct;

  // --- Rule: NOT EXTENDED (session RSI + VWAP) ---
  const r = rsi(sameDay.map((c) => c.close), 14);
  let pv = 0, vv = 0;
  for (const c of sameDay) { pv += ((c.high + c.low + c.close) / 3) * (c.volume || 0); vv += c.volume || 0; }
  const vwap = vv > 0 ? pv / vv : entry;
  const vwapExtPct = ((entry - vwap) / vwap) * 100;
  const notExtended = (r == null || r < p.rsiHot) && vwapExtPct < p.vwapExtPct;

  const pass = nearSupport && notExtended;
  const reason = pass
    ? 'ok (at support, not extended)'
    : [
        !nearSupport ? `not-at-support (${distSupportPct == null ? 'none below' : distSupportPct.toFixed(2) + '% away'})` : null,
        !notExtended ? `extended (rsi=${r == null ? 'n/a' : r.toFixed(0)}, vwap+${vwapExtPct.toFixed(2)}%)` : null,
      ].filter(Boolean).join('; ');

  return {
    pass, skipped: false, nearSupport, notExtended, reason,
    detail: { nearestSupport, distSupportPct, rsi: r, vwapExtPct },
  };
}
