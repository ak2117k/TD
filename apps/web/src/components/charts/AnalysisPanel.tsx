import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import type { CombinedTier, ContextFactorBreakdown } from '@/types';

const DRAG_POSITION_STORAGE_KEY = 'td:analysis-panel-pos';

interface DragPosition {
  x: number;
  y: number;
}

/**
 * Position + drag state for a floating chart panel. Position persists in
 * localStorage so the panel stays put across reloads, symbol switches, and
 * remounts. `null` position = "use the default top-right placement" — that
 * way first-time users see the panel where the existing CSS puts it instead
 * of in some confusing relocated spot.
 *
 * Drag handle is wired separately (caller spreads `dragHandleProps` onto the
 * element they want to be draggable) so the rest of the panel keeps normal
 * click/select behaviour for chips, tooltips, and option-row text.
 */
function useDraggablePanel() {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragOffsetRef = useRef<DragPosition>({ x: 0, y: 0 });
  const [position, setPosition] = useState<DragPosition | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem(DRAG_POSITION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
      if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null;
      return { x: parsed.x, y: parsed.y };
    } catch {
      return null;
    }
  });
  const [isDragging, setIsDragging] = useState(false);
  // Held in a ref so onPointerUp can persist the latest position without
  // racing the setState batch.
  const positionRef = useRef<DragPosition | null>(position);
  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  const dragHandleProps = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      // Left mouse button or touch only — ignore right-click / aux button.
      if (e.button !== 0) return;
      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      dragOffsetRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
      setIsDragging(true);
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {
        /* capture not supported (very old browser) — fall back to global listeners */
      }
      e.preventDefault();
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      // Clamp to viewport so the panel can't be dragged completely off-screen
      // and become unreachable. We only clamp the top-left corner; users can
      // still drag mostly out the right/bottom for screen-grabs etc.
      const next: DragPosition = {
        x: Math.max(0, e.clientX - dragOffsetRef.current.x),
        y: Math.max(0, e.clientY - dragOffsetRef.current.y),
      };
      setPosition(next);
    },
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      setIsDragging(false);
      try {
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      } catch {
        /* nothing to release */
      }
      try {
        if (positionRef.current) {
          window.localStorage.setItem(
            DRAG_POSITION_STORAGE_KEY,
            JSON.stringify(positionRef.current),
          );
        }
      } catch {
        /* private mode / quota — drop on the floor */
      }
    },
    // Double-click the handle to reset to the default top-right placement.
    onDoubleClick: () => {
      setPosition(null);
      try {
        window.localStorage.removeItem(DRAG_POSITION_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    },
    style: {
      cursor: isDragging ? 'grabbing' : 'grab',
      // Prevent the browser from interpreting touch-drag as a scroll gesture.
      touchAction: 'none' as const,
      userSelect: 'none' as const,
    },
    title: 'Drag to move · double-click to reset position',
  };

  // When position is set, override the Tailwind `top-4 right-4` defaults.
  const wrapperStyle: React.CSSProperties | undefined = position
    ? { top: position.y, left: position.x, right: 'auto' }
    : undefined;
  const useDefaultPlacement = position === null;

  return { panelRef, wrapperStyle, useDefaultPlacement, dragHandleProps };
}

export interface LevelsSnapshot {
  pdh: number;
  pdl: number;
  orh: number | null;
  orl: number | null;
  vwap: number;
  todayHigh: number;
  todayLow: number;
  atr14: number;
}

export interface IndicatorReadings {
  ema9: number | null;
  ema21: number | null;
  rsi14: number | null;
  macdHistogram: number | null;
  bollingerPosition: number | null; // -1 to +1
  roc10: number | null; // percentage
  alignment: {
    ema: 1 | 0 | -1;
    rsi: 1 | 0 | -1;
    macd: 1 | 0 | -1;
    bollinger: 1 | 0 | -1;
    momentum: 1 | 0 | -1;
  };
  agreement: number; // -5 to +5
}

export type SetupStatus =
  | 'PENDING'      // setup fired, spot hasn't crossed entry yet
  | 'ACTIVE'       // entry hit, position notionally live
  | 'PARTIAL_BOOKED' // 50% exited at 1×SL, runner trailing
  | 'TARGET_HIT'   // closed: profit
  | 'STOPPED'      // closed: loss
  | 'TRAIL_STOPPED' // runner exited via trailing stop
  | 'EOD'          // closed: session ended without resolution
  | 'INVALIDATED'; // closed: structural change

/**
 * Optimal-strike recommendation locked in by the backend at the moment a
 * setup fires. All fields optional so an older backend (without this in
 * the response) still renders the rest of the panel.
 */
export interface RecommendedStrike {
  strike: number;
  side: 'CE' | 'PE';
  expiry: string;
  ltp: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  oi: number;
  volume: number;
  expectedProfitPerShare: number;
  expectedLossPerShare: number;
  lotSize: number;
  expectedProfitPerLot: number;
  expectedLossPerLot: number;
  reason: string;
}

export interface SetupAnalysis {
  kind: 'setup';
  symbol: string;
  side: 'BUY' | 'SELL';
  entry: number;
  stoploss: number;
  target: number;
  levelType: 'PDH' | 'PDL' | 'ORH' | 'ORL' | 'VWAP' | 'ROUND' | 'VOL_STRIKE';
  setupType: 'BREAKOUT' | 'REVERSAL';
  grade: 'A' | 'B' | 'C';
  atr14: number;
  volumeRatio: number;
  levels: LevelsSnapshot;
  reason: string;
  indicators?: IndicatorReadings;
  /**
   * Higher-timeframe trend snapshot used by the MTF gate. The frontend
   * only needs the bias label + the higher-TF identifier for the chip;
   * ema9/ema21 numbers can be omitted from the type without affecting
   * runtime (they're still on the wire).
   */
  higherTimeframeTrend?: {
    tf: string;
    bias: 'bullish' | 'bearish' | 'neutral';
  } | null;
  /**
   * Daily regime classification (intraday range vs ATR14). Optional — older
   * backend builds may not emit this, so the chip is rendered only when
   * the field is present.
   */
  regime?: 'trending' | 'choppy' | 'normal' | null;
  intradayRangeRatio?: number;
  // Locked-setup fields. Once a setup is detected, the backend freezes
  // entry/SL/target and returns the same numbers across every poll until
  // it transitions to a closed state — so the chart panel becomes a
  // stable, executable plan instead of drifting with every tick.
  status?: SetupStatus;
  setupId?: string;
  triggeredAt?: string | null;
  partialTakeAt?: number;
  trailingSl?: number | null;
  partialBookedAt?: string | null;
  /** Backend-locked optimal-strike pick. Optional so stale builds still render. */
  recommendedStrike?: RecommendedStrike | null;
  /**
   * Adaptive auto-invalidation metadata. Only populated when the backend
   * tears down a locked setup mid-trade via one of the three new
   * mechanisms (structural shift, opposite setup firing, time-based MFE
   * decay). Manual invalidations and older signals leave both fields
   * null/undefined — UI must guard with optional chaining.
   */
  invalidationKind?: 'structural' | 'counter-setup' | 'time-mfe' | null;
  invalidationReason?: string | null;
  /** How TP1 was placed — 'obstacle' surfaces a subtitle on the TP1 row. */
  tp1Source?: 'obstacle' | 'fixed';
  tp1Obstacle?: {
    classification: 'STRONG' | 'MEDIUM';
    touchCount: number;
    nearEdge: number;
  } | null;
  /**
   * Context-scoring engine fields (Mama's 10-factor framework). All four are
   * optional — older signals or legacy code paths may omit them, in which
   * case the Market Context section is hidden entirely. Mirrors the backend
   * SetupContext fields in apps/api/.../setup-context.types.ts.
   */
  contextScore?: number;
  contextTier?: CombinedTier;
  contextCoverage?: number;
  contextFactors?: ContextFactorBreakdown[];
}

export type RejectGate =
  | 'distance'
  | 'confirmation'
  | 'rr'
  | 'regime-mismatch'
  | 'mtf-conflict'
  | 'grade-c';

export interface RankedReject {
  levelType: string;
  levelValue: number;
  blockedAt: RejectGate;
  side: 'BUY' | 'SELL' | null;
  progress: number;
  blockedReason: string;
  needsFor: string;
  detail?: Record<string, unknown>;
}

export interface NoSetupAnalysis {
  kind: 'no-setup';
  reason: string;
  levels: LevelsSnapshot | null;
  /** Per-level rejections sorted by closeness to firing. Optional so an
   *  older backend without the field still renders the panel. */
  rejections?: RankedReject[];
}

export type AnalysisDto = SetupAnalysis | NoSetupAnalysis;

interface AnalysisPanelProps {
  analysis: AnalysisDto | null;
  loading?: boolean;
}

function fmt(n: number): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtRupees0(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  const absRounded = Math.round(Math.abs(n));
  return `${sign}₹ ${absRounded.toLocaleString('en-IN')}`;
}

function fmtPremium(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function computeRR(setup: SetupAnalysis): string {
  const risk = Math.abs(setup.entry - setup.stoploss);
  const reward = Math.abs(setup.target - setup.entry);
  if (risk === 0) return '–';
  return `1:${(reward / risk).toFixed(2)}`;
}

export default function AnalysisPanel({ analysis, loading }: AnalysisPanelProps) {
  // Shared draggable-panel state. Hook is called unconditionally so React's
  // rules-of-hooks are happy across the early-return branches below.
  const { panelRef, wrapperStyle, useDefaultPlacement, dragHandleProps } =
    useDraggablePanel();

  if (analysis === null && loading) {
    return (
      <div
        ref={panelRef}
        style={wrapperStyle}
        className={clsx(
          'absolute z-10 w-72 rounded-lg border border-gray-700 bg-gray-800/85 p-3 backdrop-blur-sm',
          useDefaultPlacement && 'top-4 right-4',
        )}
      >
        <div {...dragHandleProps} className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            Analysis
          </span>
          <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
        </div>
        <div className="mt-3 space-y-2">
          <div className="h-3 w-3/4 animate-pulse rounded bg-gray-700/60" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-gray-700/60" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-gray-700/60" />
        </div>
        <div className="mt-3 text-[11px] italic text-gray-500">Analyzing...</div>
      </div>
    );
  }

  if (analysis === null) return null;

  if (analysis.kind === 'no-setup') {
    const topRejects = (analysis.rejections ?? []).slice(0, 3);
    return (
      <div
        ref={panelRef}
        style={wrapperStyle}
        className={clsx(
          'absolute z-10 w-72 rounded-lg border border-gray-700 bg-gray-800/85 p-3 backdrop-blur-sm',
          useDefaultPlacement && 'top-4 right-4',
        )}
      >
        <div {...dragHandleProps} className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            Analysis
          </span>
          <span className="h-2 w-2 animate-pulse rounded-full bg-gray-500" />
        </div>
        <div className="mt-2 text-sm font-semibold text-gray-300">No setup right now</div>

        {topRejects.length > 0 ? (
          <div className="mt-2 space-y-1.5 border-t border-gray-700/60 pt-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              Closest to firing
            </div>
            {topRejects.map((r, i) => (
              <RejectRow key={`${r.levelType}-${r.levelValue}-${i}`} reject={r} highlight={i === 0} />
            ))}
          </div>
        ) : (
          <div className="mt-1 text-[11px] italic text-gray-500" title={analysis.reason}>
            {analysis.reason}
          </div>
        )}

        {analysis.levels && (
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-gray-700/60 pt-2 text-[11px]">
            <div className="flex justify-between">
              <span className="text-gray-500">PDH</span>
              <span className="font-mono tabular-nums text-gray-300">{fmt(analysis.levels.pdh)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">PDL</span>
              <span className="font-mono tabular-nums text-gray-300">{fmt(analysis.levels.pdl)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">VWAP</span>
              <span className="font-mono tabular-nums text-gray-300">{fmt(analysis.levels.vwap)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">ATR14</span>
              <span className="font-mono tabular-nums text-gray-300">{fmt(analysis.levels.atr14)}</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  const isBuy = analysis.side === 'BUY';
  const gradeClass =
    analysis.grade === 'A'
      ? 'bg-emerald-500/20 text-emerald-300'
      : analysis.grade === 'B'
        ? 'bg-blue-500/20 text-blue-300'
        : 'bg-gray-500/20 text-gray-300';

  return (
    <div
      ref={panelRef}
      style={wrapperStyle}
      className={clsx(
        'absolute z-10 w-72 rounded-lg border bg-gray-800/85 p-3 backdrop-blur-sm',
        useDefaultPlacement && 'top-4 right-4',
        isBuy ? 'border-emerald-500/40' : 'border-red-500/40',
      )}
    >
      <div {...dragHandleProps} className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          Analysis
        </span>
        <span
          className={clsx(
            'h-2 w-2 animate-pulse rounded-full',
            isBuy ? 'bg-emerald-400' : 'bg-red-400',
          )}
        />
      </div>

      <div className="mt-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <div
            className={clsx(
              'rounded-md px-2 py-1 text-xs font-bold',
              isBuy ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400',
            )}
          >
            {analysis.side}
          </div>
          {analysis.status && (
            <StatusBadge
              status={analysis.status}
              invalidationKind={analysis.invalidationKind ?? null}
            />
          )}
        </div>
        <div className="text-[11px] text-gray-300">
          <span className="font-semibold text-gray-100">{analysis.symbol}</span>
          <span className="mx-1 text-gray-500">·</span>
          <span className="text-gray-400">
            {analysis.levelType} {analysis.setupType}
          </span>
        </div>
      </div>

      {analysis.status === 'INVALIDATED' && analysis.invalidationReason && (() => {
        const kindLabel =
          analysis.invalidationKind === 'structural'
            ? 'STRUCTURAL EXIT'
            : analysis.invalidationKind === 'counter-setup'
              ? 'COUNTER FLIP'
              : analysis.invalidationKind === 'time-mfe'
                ? 'TIMED OUT'
                : 'CLOSED';
        return (
          <div className="mt-3 rounded-md border-2 border-amber-500/50 bg-amber-500/10 px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
              <span>⚠</span>
              <span>Invalidated — {kindLabel}</span>
            </div>
            <div className="mt-1 text-[11px] leading-snug text-amber-100/90">
              {analysis.invalidationReason}
            </div>
          </div>
        );
      })()}

      <div
        className={clsx(
          'mt-3 space-y-1.5 text-[12px]',
          analysis.status === 'INVALIDATED' && 'opacity-60',
        )}
      >
        <div className="flex items-center justify-between">
          <span className="text-amber-400">Entry</span>
          <span className="font-mono tabular-nums text-gray-100">{fmt(analysis.entry)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-red-400">SL</span>
          <span className="font-mono tabular-nums text-gray-100">{fmt(analysis.stoploss)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-emerald-400">Target</span>
          <span className="font-mono tabular-nums text-gray-100">{fmt(analysis.target)}</span>
        </div>
      </div>

      {analysis.partialTakeAt !== undefined && analysis.partialTakeAt !== null && (
        <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 border-t border-gray-700/60 pt-2">
          <span className="text-[10px] uppercase tracking-wider text-gray-500">TP1</span>
          <span className="text-right">
            <span className="font-mono text-[11px] tabular-nums text-white">
              {fmt(analysis.partialTakeAt)}
            </span>
            {analysis.tp1Source === 'obstacle' && analysis.tp1Obstacle && (
              <span
                className="ml-1.5 text-[9px] uppercase tracking-wider text-gray-500"
                title={`TP1 sits just before a ${analysis.tp1Obstacle.classification} zone with ${analysis.tp1Obstacle.touchCount} historical touches at ${analysis.tp1Obstacle.nearEdge.toFixed(2)}`}
              >
                at {analysis.tp1Obstacle.classification.toLowerCase()} zone · {analysis.tp1Obstacle.touchCount}t
              </span>
            )}
          </span>
          {analysis.status === 'PARTIAL_BOOKED' && (
            <>
              <span className="text-[10px] uppercase tracking-wider text-gray-500">Trail</span>
              <span className="text-right font-mono text-[11px] tabular-nums text-white">
                {analysis.trailingSl !== null && analysis.trailingSl !== undefined
                  ? fmt(analysis.trailingSl)
                  : '—'}
              </span>
            </>
          )}
          <span className="text-[10px] uppercase tracking-wider text-gray-500">Tgt2</span>
          <span className="text-right font-mono text-[11px] tabular-nums text-white">
            {fmt(analysis.target)}
          </span>
        </div>
      )}

      {analysis.recommendedStrike && (() => {
        const r = analysis.recommendedStrike!;
        const expiryShort = r.expiry.slice(0, 10);
        const showLot = r.lotSize > 1;
        return (
          <div className="mt-3 border-t border-gray-700/60 pt-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              Options Play
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px] text-gray-200">
              <span className="font-semibold tabular-nums">
                {r.side} {fmt(r.strike)}
              </span>
              <span className="text-gray-500">Exp {expiryShort}</span>
            </div>
            <div className="mt-1 grid grid-cols-3 gap-x-2 text-[10px] tabular-nums">
              <div className="flex flex-col">
                <span className="text-gray-500">Premium</span>
                <span className="text-gray-100">{fmtPremium(r.ltp)}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-gray-500">Δ</span>
                <span className="text-gray-100">{r.delta.toFixed(2)}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-gray-500">IV</span>
                <span className="text-gray-100">{r.iv.toFixed(1)}</span>
              </div>
            </div>
            <div className="mt-2">
              <div className="text-[10px] uppercase tracking-wider text-gray-500">
                Expected P&amp;L
              </div>
              <div className="mt-0.5 flex items-center justify-between text-[11px] tabular-nums">
                <span className="text-emerald-400">
                  {showLot
                    ? `${fmtRupees0(r.expectedProfitPerLot)} / lot @ TGT`
                    : `${fmtRupees0(r.expectedProfitPerShare)} @ TGT`}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px] tabular-nums">
                <span className="text-red-400">
                  {showLot
                    ? `-₹ ${Math.round(Math.abs(r.expectedLossPerLot)).toLocaleString('en-IN')} / lot @ SL`
                    : `-₹ ${Math.abs(r.expectedLossPerShare).toFixed(2)} @ SL`}
                </span>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="mt-3 flex items-center justify-between border-t border-gray-700/60 pt-2 text-[10px]">
        <span className="rounded bg-gray-700/60 px-1.5 py-0.5 font-mono tabular-nums text-gray-200">
          {computeRR(analysis)}
        </span>
        <span className={clsx('rounded px-1.5 py-0.5 font-bold', gradeClass)}>
          Grade {analysis.grade}
        </span>
        <span className="font-mono tabular-nums text-gray-400">
          vol {analysis.volumeRatio.toFixed(2)}×
        </span>
      </div>

      {analysis.higherTimeframeTrend && (() => {
        const mtf = analysis.higherTimeframeTrend!;
        const label =
          mtf.bias === 'bullish'
            ? 'BULLISH'
            : mtf.bias === 'bearish'
              ? 'BEARISH'
              : 'NEUTRAL';
        const arrow = mtf.bias === 'bullish' ? '↑' : mtf.bias === 'bearish' ? '↓' : '—';
        const tone = clsx(
          mtf.bias === 'bullish' && 'text-emerald-400',
          mtf.bias === 'bearish' && 'text-red-400',
          mtf.bias === 'neutral' && 'text-gray-400',
        );
        return (
          <div className="mt-2 flex items-center justify-between border-t border-gray-700/60 pt-2 text-[10px]">
            <span className="font-semibold uppercase tracking-wider text-gray-500">
              {mtf.tf.toUpperCase()} Trend
            </span>
            <span className={clsx('font-semibold uppercase tracking-wider', tone)}>
              {label} {arrow}
            </span>
          </div>
        );
      })()}

      {analysis.regime && (() => {
        const regime = analysis.regime!;
        const ratio = analysis.intradayRangeRatio ?? 0;
        const label =
          regime === 'trending' ? 'TRENDING' : regime === 'choppy' ? 'CHOPPY' : 'NORMAL';
        const tone = clsx(
          regime === 'trending' && 'text-emerald-400',
          regime === 'choppy' && 'text-amber-400',
          regime === 'normal' && 'text-gray-400',
        );
        return (
          <div className="mt-2 flex items-center justify-between border-t border-gray-700/60 pt-2 text-[10px]">
            <span className="font-semibold uppercase tracking-wider text-gray-500">
              Regime
            </span>
            <span className={clsx('font-semibold uppercase tracking-wider', tone)}>
              {label} ({ratio.toFixed(1)}×)
            </span>
          </div>
        );
      })()}

      {analysis.indicators && (() => {
        const ind = analysis.indicators;
        const aligned = (
          [ind.alignment.ema, ind.alignment.rsi, ind.alignment.macd, ind.alignment.bollinger, ind.alignment.momentum] as const
        ).filter((v) => v === 1).length;
        const arrow = isBuy ? '↑' : '↓';
        const headerClass =
          ind.agreement >= 4
            ? 'text-emerald-400'
            : ind.agreement <= -2
              ? 'text-red-400'
              : 'text-gray-400';

        const fmtMacd = (v: number | null) =>
          v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
        const fmtRsi = (v: number | null) => (v === null ? 'n/a' : v.toFixed(1));
        const fmtRoc = (v: number | null) =>
          v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
        const emaTitle =
          ind.ema9 !== null && ind.ema21 !== null
            ? `EMA9${ind.ema9 > ind.ema21 ? '>' : ind.ema9 < ind.ema21 ? '<' : '='}EMA21`
            : 'EMA n/a';
        const bbTitle =
          ind.bollingerPosition === null
            ? 'BB n/a'
            : `BB pos ${ind.bollingerPosition >= 0 ? '+' : ''}${ind.bollingerPosition.toFixed(2)}`;

        const chips: { label: string; alignment: 1 | 0 | -1; title: string }[] = [
          { label: 'EMA', alignment: ind.alignment.ema, title: emaTitle },
          { label: 'RSI', alignment: ind.alignment.rsi, title: `RSI ${fmtRsi(ind.rsi14)}` },
          { label: 'MACD', alignment: ind.alignment.macd, title: `MACD hist ${fmtMacd(ind.macdHistogram)}` },
          { label: 'BB', alignment: ind.alignment.bollinger, title: bbTitle },
          { label: 'MOM', alignment: ind.alignment.momentum, title: `ROC10 ${fmtRoc(ind.roc10)}` },
        ];

        return (
          <div className="mt-3 border-t border-gray-700/60 pt-2">
            <div className={clsx('text-[10px] font-semibold uppercase tracking-wider', headerClass)}>
              Confluence: {aligned}/5 {arrow}
            </div>
            <div className="mt-1.5 flex items-center gap-1">
              {chips.map((chip) => (
                <span
                  key={chip.label}
                  title={chip.title}
                  className={clsx(
                    'text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded',
                    chip.alignment === 1
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : chip.alignment === -1
                        ? 'bg-red-500/15 text-red-400'
                        : 'bg-gray-700/40 text-gray-500',
                  )}
                >
                  {chip.label}
                </span>
              ))}
            </div>
          </div>
        );
      })()}

      {analysis.contextScore !== undefined && analysis.contextFactors && (
        <div className="mt-3 border-t border-gray-700/60 pt-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              Market Context
            </span>
            <span
              className={clsx(
                'text-[11px] font-bold tabular-nums',
                analysis.contextTier === 'STRONG_BULL' && 'text-emerald-400',
                analysis.contextTier === 'BULL' && 'text-emerald-300',
                analysis.contextTier === 'STRONG_BEAR' && 'text-red-400',
                analysis.contextTier === 'BEAR' && 'text-red-300',
                analysis.contextTier === 'NEUTRAL' && 'text-gray-300',
              )}
            >
              {analysis.contextScore > 0 ? '+' : ''}
              {analysis.contextScore} {analysis.contextTier?.replace('_', ' ')}
            </span>
          </div>
          <div className="mt-0.5 text-[9px] text-gray-500">
            {analysis.contextFactors.filter((f) => !f.isStub).length}/
            {analysis.contextFactors.length} factors active · coverage{' '}
            {Math.round((analysis.contextCoverage ?? 0) * 100)}%
          </div>
          <div className="mt-1.5 space-y-0.5">
            {analysis.contextFactors.map((f) => (
              <div
                key={f.name}
                className="flex items-center justify-between text-[10px]"
              >
                <span
                  className={clsx(
                    'font-mono uppercase tracking-wider',
                    f.isStub ? 'text-gray-600' : 'text-gray-400',
                  )}
                >
                  {f.name}
                </span>
                <div className="flex items-center gap-2">
                  <span
                    className={clsx(
                      'rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider',
                      f.isStub
                        ? 'bg-gray-700/30 text-gray-500'
                        : f.tier === 'STRONG_BULL'
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : f.tier === 'BULL'
                            ? 'bg-emerald-500/10 text-emerald-300'
                            : f.tier === 'STRONG_BEAR'
                              ? 'bg-red-500/15 text-red-400'
                              : f.tier === 'BEAR'
                                ? 'bg-red-500/10 text-red-300'
                                : 'bg-gray-700/40 text-gray-400',
                    )}
                    title={
                      f.isStub
                        ? 'Stub factor — backend returns NEUTRAL_STUB until implemented'
                        : `value ${f.value.toFixed(2)} · weight ${(f.weight * 100).toFixed(0)}%`
                    }
                  >
                    {f.isStub ? 'STUB' : f.tier.replace('_', ' ')}
                  </span>
                  <span
                    className={clsx(
                      'w-8 text-right tabular-nums',
                      f.contribution > 0
                        ? 'text-emerald-400'
                        : f.contribution < 0
                          ? 'text-red-400'
                          : 'text-gray-500',
                    )}
                  >
                    {f.contribution > 0 ? '+' : ''}
                    {Math.round(f.contribution)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-2 truncate text-[10px] italic text-gray-500" title={analysis.reason}>
        {analysis.reason}
      </div>
    </div>
  );
}

function RejectRow({ reject, highlight }: { reject: RankedReject; highlight: boolean }) {
  // Visual intensity scales with how far the level got. Distance/confirmation
  // rejects are dim, mtf-conflict / grade-c are nearly green because they
  // mean the setup almost fired.
  const tone =
    reject.progress >= 4
      ? 'border-emerald-500/40 bg-emerald-500/5'
      : reject.progress >= 2
        ? 'border-amber-500/30 bg-amber-500/5'
        : 'border-gray-700/60 bg-gray-800/40';
  const sideColor =
    reject.side === 'BUY'
      ? 'text-emerald-400'
      : reject.side === 'SELL'
        ? 'text-red-400'
        : 'text-gray-400';
  return (
    <div className={clsx('rounded border px-2 py-1.5', tone, highlight && 'ring-1 ring-amber-500/30')}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {reject.side && (
            <span className={clsx('text-[9px] font-bold uppercase', sideColor)}>{reject.side}</span>
          )}
          <span className="rounded bg-gray-700/60 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-gray-300">
            {reject.levelType}
          </span>
          <span className="font-mono tabular-nums text-[11px] text-gray-200">
            {fmt(reject.levelValue)}
          </span>
        </div>
        <span className="text-[9px] font-mono tabular-nums text-gray-500">{reject.progress}/5</span>
      </div>
      <div className="mt-0.5 text-[10px] leading-tight text-gray-400">{reject.blockedReason}</div>
      {reject.needsFor && (
        <div className="text-[10px] leading-tight text-gray-500">
          <span className="text-gray-600">needs: </span>
          {reject.needsFor}
        </div>
      )}
    </div>
  );
}

function StatusBadge({
  status,
  invalidationKind,
}: {
  status: SetupStatus;
  invalidationKind?: SetupAnalysis['invalidationKind'];
}) {
  const cfg: Record<SetupStatus, { label: string; classes: string; pulse: boolean }> = {
    PENDING:        { label: 'PENDING',    classes: 'bg-amber-500/15 text-amber-300',     pulse: true },
    ACTIVE:         { label: 'ACTIVE',     classes: 'bg-blue-500/20 text-blue-300',       pulse: true },
    PARTIAL_BOOKED: { label: 'TP1 BOOKED', classes: 'bg-cyan-500/20 text-cyan-300',       pulse: true },
    TARGET_HIT:     { label: 'TARGET',     classes: 'bg-emerald-500/20 text-emerald-300', pulse: false },
    STOPPED:        { label: 'STOPPED',    classes: 'bg-red-500/20 text-red-300',         pulse: false },
    TRAIL_STOPPED:  { label: 'TRAIL EXIT', classes: 'bg-violet-500/20 text-violet-300',   pulse: false },
    EOD:            { label: 'EOD',        classes: 'bg-gray-700/40 text-gray-400',       pulse: false },
    INVALIDATED:    { label: 'CLOSED',     classes: 'bg-gray-700/40 text-gray-400',       pulse: false },
  };

  // Mechanism-aware override for INVALIDATED. When the backend signals
  // *why* the setup was torn down via the new adaptive-invalidation
  // pipeline, swap the generic "CLOSED" pill for a tone that hints at
  // the cause. Falls through to the default "CLOSED" pill when
  // invalidationKind is null/missing (manual invalidation or older
  // signals).
  let c = cfg[status];
  if (status === 'INVALIDATED' && invalidationKind) {
    if (invalidationKind === 'structural') {
      c = { label: 'STRUCTURAL EXIT', classes: 'bg-amber-500/20 text-amber-300', pulse: false };
    } else if (invalidationKind === 'counter-setup') {
      c = { label: 'COUNTER FLIP', classes: 'bg-violet-500/20 text-violet-300', pulse: false };
    } else if (invalidationKind === 'time-mfe') {
      c = { label: 'TIMED OUT', classes: 'bg-gray-600/40 text-gray-300', pulse: false };
    }
  }

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider',
        c.classes,
      )}
    >
      {c.pulse && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {c.label}
    </span>
  );
}
