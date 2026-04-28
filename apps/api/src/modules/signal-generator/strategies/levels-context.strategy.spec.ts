// levels-context.strategy.spec.ts
import { LevelsContextStrategy } from './levels-context.strategy';
import { LevelBook } from '../types/level-book.types';
import { CandleData } from '../../../common/interfaces/trading-strategy.interface';

describe('LevelsContextStrategy.analyze', () => {
  let strategy: LevelsContextStrategy;
  beforeEach(() => {
    strategy = new LevelsContextStrategy();
    // These fixtures put the trigger candle at the END of the array
    // (length-1). Production defaults to evaluating against the last
    // CLOSED bar (length-2), so opt back into legacy mode for tests.
    strategy.setParameters({ evaluateOnLastBar: true });
  });

  // Build N 5-min candles ending at a target close. ATR/volume are configurable.
  const buildCandles = (count: number, opts: {
    closes?: number[]; volumes?: number[];
    open?: number; high?: number; low?: number;
  }): CandleData[] => {
    const candles: CandleData[] = [];
    for (let i = 0; i < count; i++) {
      const close = opts.closes?.[i] ?? 24100;
      const volume = opts.volumes?.[i] ?? 100_000;
      candles.push({
        timestamp: new Date(`2026-04-27T10:${String(i).padStart(2, '0')}:00+05:30`),
        open: opts.open ?? close - 5,
        high: opts.high ?? close + 10,
        low: opts.low ?? close - 10,
        close,
        volume,
      });
    }
    return candles;
  };

  const baseLevelBook = (overrides?: Partial<LevelBook>): LevelBook => ({
    token: '99926000',
    symbol: 'NIFTY',
    exchange: 'NSE',
    asOf: new Date(),
    pdh: 24180,
    pdl: 23950,
    prevClose: 24100,
    orh: 24160,
    orl: 24080,
    orLocked: true,
    spot: 24100,
    vwap: 24090,
    todayHigh: 24160,
    todayLow: 24050,
    atr14: 100,
    lastTickAt: new Date(),
    roundNumbers: [24000, 24050, 24100, 24150, 24200],
    ...overrides,
  });

  // ---- Distance gate ----
  it('returns null when spot is too far from every level', () => {
    const book = baseLevelBook({ spot: 24500 });
    const candles = buildCandles(25, { closes: Array(25).fill(24500) });
    expect(strategy.analyze({ candles, levelBook: book, nowIst: '10:00' })).toBeNull();
  });

  // ---- Time-of-day gate ----
  it('returns null when current time is in midday chop window', () => {
    const book = baseLevelBook();
    // Last close right at PDH 24180 with volume spike — would normally fire
    const candles = buildCandles(25, {
      closes: [...Array(24).fill(24100), 24185],
      volumes: [...Array(20).fill(100_000), ...Array(5).fill(200_000)],
    });
    expect(strategy.analyze({ candles, levelBook: book, nowIst: '12:30' })).toBeNull();
  });

  // ---- Stale level book ----
  it('returns null when level book is stale (lastTickAt > 60s old)', () => {
    const book = baseLevelBook({ lastTickAt: new Date(Date.now() - 90_000) });
    const candles = buildCandles(25, { closes: [...Array(24).fill(24100), 24185] });
    expect(strategy.analyze({ candles, levelBook: book, nowIst: '10:00' })).toBeNull();
  });

  // ---- Breakout pass ----
  it('emits BREAKOUT signal when 5m close > level + 0.1·ATR with volume confirm', () => {
    const book = baseLevelBook({ spot: 24190 });
    // 25 bars: first 20 average ~100k volume, last bars spike to 200k
    const candles = buildCandles(25, {
      closes: [...Array(24).fill(24100), 24195],
      volumes: [...Array(20).fill(100_000), ...Array(5).fill(200_000)],
    });
    const out = strategy.analyze({ candles, levelBook: book, nowIst: '10:30' });
    expect(out).not.toBeNull();
    expect(out!.metadata!.setupType).toBe('BREAKOUT');
    expect(out!.metadata!.levelType).toBe('PDH');
    expect(out!.side).toBe('BUY');
  });

  // ---- Reversal pass ----
  it('emits REVERSAL signal on pinbar rejection at PDH', () => {
    const book = baseLevelBook({ spot: 24165 });
    // Pinbar candle: long upper wick into PDH(24180), close near low
    const lastCandle: CandleData = {
      timestamp: new Date('2026-04-27T10:30:00+05:30'),
      open: 24160,
      high: 24182,    // wick into PDH
      low: 24150,
      close: 24158,   // body small + back below level
      volume: 130_000,
    };
    const earlier = buildCandles(24, { closes: Array(24).fill(24160), volumes: Array(24).fill(100_000) });
    const candles = [...earlier, lastCandle];
    const out = strategy.analyze({ candles, levelBook: book, nowIst: '10:30' });
    expect(out).not.toBeNull();
    expect(out!.metadata!.setupType).toBe('REVERSAL');
    expect(out!.side).toBe('SELL'); // rejection at resistance → short bias
  });

  // ---- R:R fail ----
  it('returns null when R:R math fails (target < 2× SL)', () => {
    // PDH=24180, spot=24179, no other levels nearby — target distance too small
    const book = baseLevelBook({
      spot: 24179, pdh: 24180,
      orh: 24210,   // very close — would make target < 2×SL
      orl: 23950, vwap: 24179, todayHigh: 24179, todayLow: 24050,
      atr14: 50,    // tiny ATR exaggerates the issue
      roundNumbers: [],
    });
    const candles = buildCandles(25, {
      closes: [...Array(24).fill(24178), 24185],
      volumes: [...Array(20).fill(100_000), ...Array(5).fill(200_000)],
    });
    expect(strategy.analyze({ candles, levelBook: book, nowIst: '10:00' })).toBeNull();
  });

  // ---- Volume gate fail ----
  it('returns null when breakout candle volume < 1.2× VMA20', () => {
    const book = baseLevelBook({ spot: 24190 });
    const candles = buildCandles(25, {
      closes: [...Array(24).fill(24100), 24195],
      // No volume spike on the trigger candle
      volumes: Array(25).fill(100_000),
    });
    expect(strategy.analyze({ candles, levelBook: book, nowIst: '10:00' })).toBeNull();
  });

  // ---- Grade A: confluence ----
  it('grades A when level is in confluence with another level (within 0.1·ATR)', () => {
    // PDH 24180 + round number 24150 within 0.3·ATR; spot interacts with PDH
    const book = baseLevelBook({
      spot: 24190,
      pdh: 24180,
      roundNumbers: [24150, 24180, 24200, 24250],
    });
    const candles = buildCandles(25, {
      closes: [...Array(24).fill(24100), 24195],
      volumes: [...Array(20).fill(100_000), ...Array(5).fill(160_000)],
    });
    const out = strategy.analyze({ candles, levelBook: book, nowIst: '10:00' });
    expect(out).not.toBeNull();
    expect(out!.metadata!.grade).toBe('A');
  });

  // ---- Indicator confluence: bullish boost upgrades grade ----
  it('upgrades grade when indicators align bullish on a BUY breakout', () => {
    // 40 closes with a steady uptrend mixed with small pullbacks so RSI
    // lands in the (50, 70) trend-zone rather than getting stretched
    // toward 100. MACD needs 35+ closes (slow=26 + signal=9) to render
    // a non-null histogram. Volume spikes only on the trigger candle so
    // the base grade is B (no prime-window confluence boost).
    const closes: number[] = [];
    let v = 24050;
    for (let i = 0; i < 39; i++) {
      // net-positive drift with alternating small pullbacks
      v += i % 2 === 0 ? 4 : -1;
      closes.push(v);
    }
    closes.push(24195); // breakout above PDH 24180
    const book = baseLevelBook({
      spot: 24195,
      pdh: 24180,
      roundNumbers: [24000, 24050, 24100],
    });
    const candles = buildCandles(40, {
      closes,
      volumes: [...Array(35).fill(100_000), ...Array(5).fill(150_000)],
    });
    const out = strategy.analyze({ candles, levelBook: book, nowIst: '11:00' });
    expect(out).not.toBeNull();
    const meta = out!.metadata as { indicators: { agreement: number }; grade: string };
    expect(meta.indicators.agreement).toBeGreaterThanOrEqual(4);
    expect(meta.grade).toBe('A');
  });

  // ---- Indicator confluence: bearish opposition demotes grade ----
  it('demotes grade when indicators oppose a BUY breakout', () => {
    // Strongly descending 40-bar series, then a single high-volume spike
    // candle that closes just above PDH — the breakout fires, but every
    // indicator opposes it. Base grade (volume + confluence + prime
    // window) would be A → demoted by the agreement penalty.
    const closes: number[] = [];
    for (let i = 0; i < 39; i++) closes.push(24600 - i * 5); // 24600 → 24410
    closes.push(24395); // last bar above PDH+0.1·ATR=24390 but still below recent EMAs
    const book = baseLevelBook({
      spot: 24395,
      pdh: 24380,
      orh: 24380,
      roundNumbers: [24380, 24400, 24500],
    });
    const candles = buildCandles(40, {
      closes,
      volumes: [...Array(35).fill(100_000), ...Array(5).fill(160_000)],
    });
    const out = strategy.analyze({ candles, levelBook: book, nowIst: '10:00' });
    expect(out).not.toBeNull();
    const meta = out!.metadata as { indicators: { agreement: number }; grade: string };
    expect(meta.indicators.agreement).toBeLessThanOrEqual(-2);
    expect(['B', 'C']).toContain(meta.grade);
  });

  // The MTF gate tests use REVERSAL-pattern fixtures (a pinbar wick into
  // PDH for SELL, a pinbar wick into PDL for BUY) — the same fixture
  // shape the existing pinbar-rejection test uses. We keep the gate
  // assertion narrow: gate-event presence + setup direction.
  const buyReversalFixture = (): { book: LevelBook; candles: CandleData[] } => {
    const book = baseLevelBook({ spot: 23965, pdl: 23950 });
    const lastCandle: CandleData = {
      timestamp: new Date('2026-04-27T10:30:00+05:30'),
      open: 23960,
      high: 23975,
      low: 23942,    // wick INTO PDL from above
      close: 23972,  // body small + back above level
      volume: 130_000,
    };
    const earlier = buildCandles(24, {
      closes: Array(24).fill(23960),
      volumes: Array(24).fill(100_000),
    });
    return { book, candles: [...earlier, lastCandle] };
  };

  const sellReversalFixture = (): { book: LevelBook; candles: CandleData[] } => {
    const book = baseLevelBook({ spot: 24165 });
    const lastCandle: CandleData = {
      timestamp: new Date('2026-04-27T10:30:00+05:30'),
      open: 24160,
      high: 24182,    // wick into PDH
      low: 24150,
      close: 24158,   // body small + back below level
      volume: 130_000,
    };
    const earlier = buildCandles(24, {
      closes: Array(24).fill(24160),
      volumes: Array(24).fill(100_000),
    });
    return { book, candles: [...earlier, lastCandle] };
  };

  // ---- MTF gate: bullish higher-TF allows BUY ----
  it('fires BUY setup when higher-TF trend is bullish (no conflict)', () => {
    const { book, candles } = buyReversalFixture();
    const out = strategy.analyze({
      candles, levelBook: book, nowIst: '10:30',
      higherTimeframeTrend: { tf: '1h', ema9: 24050, ema21: 23980, bias: 'bullish' },
    });
    expect(out).not.toBeNull();
    expect(out!.side).toBe('BUY');
    const meta = out!.metadata as { higherTimeframeTrend: { bias: string } };
    expect(meta.higherTimeframeTrend.bias).toBe('bullish');
  });

  // ---- MTF gate: bearish higher-TF rejects BUY ----
  it('rejects BUY setup when higher-TF trend is bearish (mtf-conflict)', () => {
    const { book, candles } = buyReversalFixture();
    const events: string[] = [];
    const out = strategy.analyze({
      candles, levelBook: book, nowIst: '10:30',
      higherTimeframeTrend: { tf: '1h', ema9: 23900, ema21: 24050, bias: 'bearish' },
      debug: (e) => events.push(e),
    });
    expect(out).toBeNull();
    expect(events).toContain('reject:mtf-conflict');
  });

  // ---- MTF gate: bullish higher-TF rejects SELL ----
  it('rejects SELL setup when higher-TF trend is bullish (mtf-conflict)', () => {
    const { book, candles } = sellReversalFixture();
    const events: string[] = [];
    const out = strategy.analyze({
      candles, levelBook: book, nowIst: '10:30',
      higherTimeframeTrend: { tf: '1h', ema9: 24180, ema21: 24100, bias: 'bullish' },
      debug: (e) => events.push(e),
    });
    expect(out).toBeNull();
    expect(events).toContain('reject:mtf-conflict');
  });

  // ---- MTF gate: neutral higher-TF allows setup ----
  it('fires BUY setup when higher-TF trend is neutral (gate skipped)', () => {
    const { book, candles } = buyReversalFixture();
    const out = strategy.analyze({
      candles, levelBook: book, nowIst: '10:30',
      higherTimeframeTrend: { tf: '1h', ema9: 24000, ema21: 24000, bias: 'neutral' },
    });
    expect(out).not.toBeNull();
    expect(out!.side).toBe('BUY');
  });

  // ---- MTF gate: null higher-TF skips the gate ----
  it('fires BUY setup when higher-TF trend is null (no MTF data)', () => {
    const { book, candles } = buyReversalFixture();
    const out = strategy.analyze({
      candles, levelBook: book, nowIst: '10:30',
      higherTimeframeTrend: null,
    });
    expect(out).not.toBeNull();
    expect(out!.side).toBe('BUY');
    const meta = out!.metadata as { higherTimeframeTrend: unknown };
    expect(meta.higherTimeframeTrend).toBeNull();
  });

  // ---- SetupContext.indicators populated ----
  it('populates SetupContext.indicators with non-null readings when history is sufficient', () => {
    const closes: number[] = [];
    let v = 24050;
    for (let i = 0; i < 39; i++) {
      v += i % 2 === 0 ? 4 : -1;
      closes.push(v);
    }
    closes.push(24195);
    const book = baseLevelBook({
      spot: 24195,
      pdh: 24180,
      roundNumbers: [24000, 24050, 24100],
    });
    const candles = buildCandles(40, {
      closes,
      volumes: [...Array(35).fill(100_000), ...Array(5).fill(160_000)],
    });
    const out = strategy.analyze({ candles, levelBook: book, nowIst: '10:00' });
    expect(out).not.toBeNull();
    const ind = (out!.metadata as { indicators: Record<string, unknown> }).indicators;
    expect(ind.ema9).not.toBeNull();
    expect(ind.ema21).not.toBeNull();
    expect(ind.rsi14).not.toBeNull();
    expect(ind.macdHistogram).not.toBeNull();
    expect(ind.bollingerPosition).not.toBeNull();
    expect(ind.roc10).not.toBeNull();
    expect(typeof ind.agreement).toBe('number');
  });
});
