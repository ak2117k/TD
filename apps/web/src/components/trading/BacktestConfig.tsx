import { useState, useEffect } from 'react';
import { Play, Plus, Loader2, Search } from 'lucide-react';
import { cn } from '@/utils/cn';
import api from '@/services/api';
import type { BacktestConfig as BacktestConfigType } from '@/stores/backtest-store';

interface Strategy {
  name: string;
  description: string;
  supportedSegments: string[];
  preferredTimeframes: string[];
}

interface BacktestConfigProps {
  config: BacktestConfigType;
  onConfigChange: (partial: Partial<BacktestConfigType>) => void;
  onSubmit: (config: BacktestConfigType) => void;
  onAddToCompare?: (config: BacktestConfigType) => void;
  isRunning: boolean;
  isCompareMode?: boolean;
}

const TIMEFRAMES = [
  { value: '5m', label: '5 min' },
  { value: '15m', label: '15 min' },
  { value: '1h', label: '1 hour' },
  { value: '1d', label: '1 day' },
];

const EXCHANGES = ['NSE', 'BSE', 'NFO', 'MCX'];

interface SymbolSuggestion {
  symbol: string;
  name: string;
  exchange: string;
}

export default function BacktestConfig({
  config,
  onConfigChange,
  onSubmit,
  onAddToCompare,
  isRunning,
  isCompareMode = false,
}: BacktestConfigProps) {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [symbolQuery, setSymbolQuery] = useState(config.symbol);
  const [symbolSuggestions, setSymbolSuggestions] = useState<SymbolSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api
      .get('/signals/strategies')
      .then((res) => {
        const data = res.data?.data ?? res.data ?? [];
        setStrategies(data);
      })
      .catch(() => {});
  }, []);

  function handleSymbolSearch(query: string) {
    setSymbolQuery(query);
    onConfigChange({ symbol: query });

    if (searchTimeout) clearTimeout(searchTimeout);

    if (query.length < 2) {
      setSymbolSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    const timeout = setTimeout(async () => {
      try {
        const res = await api.get(
          `/market-data/instruments/search?query=${encodeURIComponent(query)}&exchange=${config.exchange}`,
        );
        const instruments = res.data?.data ?? res.data ?? [];
        setSymbolSuggestions(
          instruments.slice(0, 10).map((i: any) => ({
            symbol: i.symbol,
            name: i.name,
            exchange: i.exchange,
          })),
        );
        setShowSuggestions(true);
      } catch {
        setSymbolSuggestions([]);
      }
    }, 300);

    setSearchTimeout(timeout);
  }

  function selectSymbol(suggestion: SymbolSuggestion) {
    setSymbolQuery(suggestion.symbol);
    onConfigChange({ symbol: suggestion.symbol, exchange: suggestion.exchange });
    setShowSuggestions(false);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(config);
  }

  function handleAddToCompare() {
    onAddToCompare?.(config);
  }

  const isValid =
    config.strategy &&
    config.symbol &&
    config.startDate &&
    config.endDate &&
    config.initialCapital > 0;

  const inputClass =
    'w-full rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent-blue)] focus:ring-1 focus:ring-[var(--color-accent-blue)]/30 transition-colors';

  const labelClass = 'block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Strategy */}
      <div>
        <label className={labelClass}>Strategy</label>
        <select
          value={config.strategy}
          onChange={(e) => onConfigChange({ strategy: e.target.value })}
          className={inputClass}
        >
          <option value="">Select a strategy...</option>
          {strategies.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name} - {s.description}
            </option>
          ))}
        </select>
      </div>

      {/* Symbol with autocomplete */}
      <div className="relative">
        <label className={labelClass}>Symbol</label>
        <div className="relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
          />
          <input
            type="text"
            value={symbolQuery}
            onChange={(e) => handleSymbolSearch(e.target.value)}
            onFocus={() => symbolSuggestions.length > 0 && setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
            placeholder="Search symbol (e.g. NIFTY, RELIANCE)"
            className={cn(inputClass, 'pl-9')}
          />
        </div>
        {showSuggestions && symbolSuggestions.length > 0 && (
          <div className="absolute z-20 mt-1 w-full rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] shadow-xl">
            {symbolSuggestions.map((s, i) => (
              <button
                key={i}
                type="button"
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-[var(--color-bg-tertiary)] transition-colors first:rounded-t-lg last:rounded-b-lg"
                onMouseDown={() => selectSymbol(s)}
              >
                <span className="font-medium text-[var(--color-text-primary)]">
                  {s.symbol}
                </span>
                <span className="text-xs text-[var(--color-text-muted)]">
                  {s.exchange} - {s.name}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Exchange + Timeframe */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Exchange</label>
          <select
            value={config.exchange}
            onChange={(e) => onConfigChange({ exchange: e.target.value })}
            className={inputClass}
          >
            {EXCHANGES.map((ex) => (
              <option key={ex} value={ex}>
                {ex}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Timeframe</label>
          <select
            value={config.timeframe}
            onChange={(e) => onConfigChange({ timeframe: e.target.value })}
            className={inputClass}
          >
            {TIMEFRAMES.map((tf) => (
              <option key={tf.value} value={tf.value}>
                {tf.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Date range */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Start Date</label>
          <input
            type="date"
            value={config.startDate}
            onChange={(e) => onConfigChange({ startDate: e.target.value })}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>End Date</label>
          <input
            type="date"
            value={config.endDate}
            onChange={(e) => onConfigChange({ endDate: e.target.value })}
            className={inputClass}
          />
        </div>
      </div>

      {/* Capital + Position size */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Initial Capital</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-[var(--color-text-muted)]">
              INR
            </span>
            <input
              type="number"
              value={config.initialCapital}
              onChange={(e) =>
                onConfigChange({ initialCapital: Number(e.target.value) })
              }
              min={1000}
              step={10000}
              className={cn(inputClass, 'pl-11')}
            />
          </div>
        </div>
        <div>
          <label className={labelClass}>Position Size</label>
          <input
            type="number"
            value={config.positionSize}
            onChange={(e) =>
              onConfigChange({ positionSize: Number(e.target.value) })
            }
            min={0.01}
            max={100}
            step={0.1}
            className={inputClass}
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={!isValid || isRunning}
          className={cn(
            'flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-all',
            isValid && !isRunning
              ? 'bg-[var(--color-accent-blue)] text-white hover:brightness-110'
              : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] cursor-not-allowed',
          )}
        >
          {isRunning ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Running...
            </>
          ) : (
            <>
              <Play size={16} />
              Run Backtest
            </>
          )}
        </button>

        {isCompareMode && onAddToCompare && (
          <button
            type="button"
            onClick={handleAddToCompare}
            disabled={!isValid}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-3 py-2.5 text-sm font-medium transition-all',
              isValid
                ? 'border-[var(--color-accent-yellow)] text-[var(--color-accent-yellow)] hover:bg-[var(--color-accent-yellow)]/10'
                : 'border-[var(--color-border-subtle)] text-[var(--color-text-muted)] cursor-not-allowed',
            )}
          >
            <Plus size={14} />
            Add
          </button>
        )}
      </div>
    </form>
  );
}
