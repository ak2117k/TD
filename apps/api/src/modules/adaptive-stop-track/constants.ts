// Adaptive-Stop track settings (v1 — tunable constants; calibrate ATR_MULT/bounds
// against scripts/cf-real-candles.mjs). See the design spec.
export const STARTING_BALANCE = 80_00_000; // ₹80L paper account (same as ungated, for comparability)
export const MAX_CONCURRENT = 40;
export const TRADE_COOLDOWN_MS = 45 * 60_000;
export const PROFIT_TARGET_PCT = 0.02;     // 2% from fill (same as gated/ungated)

export const RISK_PER_TRADE = 800;         // ₹ risked per trade (≈ the 0.4%-of-₹2L the gated track implies)
export const ATR_MULT = 1.2;               // stop = ATR_MULT × intraday ATR(14, 5m)
export const MIN_STOP_PCT = 0.8;           // floor on stop distance (% of entry)
export const MAX_STOP_PCT = 2.5;           // cap on stop distance (% of entry)
export const GRACE_MS = 2 * 60_000;        // no stop honored in the first 2 minutes after entry

// --- Trailing give-back (post-partial) ---
// ATR-based, replacing the old flat 0.5% that shook winners out on noise: across
// the exit-leak study, 64% of flat-trail exits went on to hit target after we
// were stopped (avg +2.65% left on the table). Calibrate alongside ATR_MULT via
// scripts/cf-real-candles.mjs.
export const TRAIL_ATR_MULT = 1.0;         // give-back = TRAIL_ATR_MULT × intraday ATR(14, 5m)
export const TRAIL_MIN_PCT = 0.6;          // floor on give-back (% of high-water)
export const TRAIL_MAX_PCT = 1.5;          // cap on give-back (% of high-water)
