import clsx from 'clsx';

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
}

export interface NoSetupAnalysis {
  kind: 'no-setup';
  reason: string;
  levels: LevelsSnapshot | null;
}

export type AnalysisDto = SetupAnalysis | NoSetupAnalysis;

interface AnalysisPanelProps {
  analysis: AnalysisDto | null;
  loading?: boolean;
}

function fmt(n: number): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function computeRR(setup: SetupAnalysis): string {
  const risk = Math.abs(setup.entry - setup.stoploss);
  const reward = Math.abs(setup.target - setup.entry);
  if (risk === 0) return '–';
  return `1:${(reward / risk).toFixed(2)}`;
}

export default function AnalysisPanel({ analysis, loading }: AnalysisPanelProps) {
  if (analysis === null && loading) {
    return (
      <div className="absolute top-4 right-4 z-10 w-72 rounded-lg border border-gray-700 bg-gray-800/85 p-3 backdrop-blur-sm">
        <div className="flex items-center justify-between">
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
    return (
      <div className="absolute top-4 right-4 z-10 w-72 rounded-lg border border-gray-700 bg-gray-800/85 p-3 backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            Analysis
          </span>
          <span className="h-2 w-2 animate-pulse rounded-full bg-gray-500" />
        </div>
        <div className="mt-2 text-sm font-semibold text-gray-300">No setup right now</div>
        <div className="mt-1 text-[11px] italic text-gray-500">{analysis.reason}</div>
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
      className={clsx(
        'absolute top-4 right-4 z-10 w-72 rounded-lg border bg-gray-800/85 p-3 backdrop-blur-sm',
        isBuy ? 'border-emerald-500/40' : 'border-red-500/40',
      )}
    >
      <div className="flex items-center justify-between">
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
        <div
          className={clsx(
            'rounded-md px-2 py-1 text-xs font-bold',
            isBuy ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400',
          )}
        >
          {analysis.side}
        </div>
        <div className="text-[11px] text-gray-300">
          <span className="font-semibold text-gray-100">{analysis.symbol}</span>
          <span className="mx-1 text-gray-500">·</span>
          <span className="text-gray-400">
            {analysis.levelType} {analysis.setupType}
          </span>
        </div>
      </div>

      <div className="mt-3 space-y-1.5 text-[12px]">
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

      <div className="mt-2 truncate text-[10px] italic text-gray-500" title={analysis.reason}>
        {analysis.reason}
      </div>
    </div>
  );
}
