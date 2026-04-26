import { useState, useEffect, useCallback } from 'react';
import { Modal } from '@/components/common';
import { cn } from '@/utils/cn';
import { OrderSide, OrderType, PositionType, ENTRY_TAG_OPTIONS } from '@/types';
import { useTradeStore } from '@/stores/trade-store';
import { useSettingsStore } from '@/stores/settings-store';
import { AutoTradeMode } from '@/types';
import api from '@/services/api';
import { Search, AlertTriangle, Loader2 } from 'lucide-react';

interface ExecuteTradeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Instrument {
  symbol: string;
  token: string;
  exchange: string;
  name: string;
}

export default function ExecuteTradeModal({ isOpen, onClose }: ExecuteTradeModalProps) {
  const executeTrade = useTradeStore((s) => s.executeTrade);
  const riskStatus = useTradeStore((s) => s.riskStatus);
  const settings = useSettingsStore((s) => s.settings);
  const isPaper = settings.autoTradeMode === AutoTradeMode.PAPER_TRADING || settings.paperTrading;

  const [symbol, setSymbol] = useState('');
  const [selectedInstrument, setSelectedInstrument] = useState<Instrument | null>(null);
  const [suggestions, setSuggestions] = useState<Instrument[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [side, setSide] = useState<OrderSide>(OrderSide.BUY);
  const [orderType, setOrderType] = useState<OrderType>(OrderType.MARKET);
  const [quantity, setQuantity] = useState<number>(1);
  const [price, setPrice] = useState<number>(0);
  const [triggerPrice, setTriggerPrice] = useState<number>(0);
  const [positionType, setPositionType] = useState<PositionType>(PositionType.INTRADAY);
  const [stoploss, setStoploss] = useState<string>('');
  const [target, setTarget] = useState<string>('');
  const [ltp, setLtp] = useState<number>(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [searchTimer, setSearchTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  // M5: capture trader rationale + tag chips at entry so the journal
  // can correlate outcomes back to the *intent* behind each trade.
  const [entryReason, setEntryReason] = useState('');
  const [entryTags, setEntryTags] = useState<string[]>([]);

  const needsPrice = orderType === OrderType.LIMIT || orderType === OrderType.STOPLOSS;
  const needsTrigger = orderType === OrderType.STOPLOSS || orderType === OrderType.STOPLOSS_MARKET;

  const estimatedValue = quantity * (needsPrice ? price : ltp);
  const riskPercent = riskStatus.capitalLimit > 0
    ? ((riskStatus.capitalDeployed + estimatedValue) / riskStatus.capitalLimit) * 100
    : 0;

  // Search instruments
  const searchInstruments = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSuggestions([]);
      return;
    }
    try {
      const { data } = await api.get<Instrument[]>('/market-data/instruments', {
        params: { search: query },
      });
      setSuggestions(data);
      setShowSuggestions(true);
    } catch {
      setSuggestions([]);
    }
  }, []);

  const handleSymbolChange = (value: string) => {
    setSymbol(value);
    setSelectedInstrument(null);
    if (searchTimer) clearTimeout(searchTimer);
    const timer = setTimeout(() => searchInstruments(value), 300);
    setSearchTimer(timer);
  };

  const selectInstrument = (instrument: Instrument) => {
    setSymbol(instrument.symbol);
    setSelectedInstrument(instrument);
    setShowSuggestions(false);
    setSuggestions([]);
    // Fetch LTP
    fetchLTP(instrument.symbol);
  };

  const fetchLTP = async (sym: string) => {
    try {
      const { data } = await api.get<{ ltp: number }>(`/market-data/ltp/${sym}`);
      setLtp(data.ltp);
    } catch {
      setLtp(0);
    }
  };

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      setSymbol('');
      setSelectedInstrument(null);
      setSide(OrderSide.BUY);
      setOrderType(OrderType.MARKET);
      setQuantity(1);
      setPrice(0);
      setTriggerPrice(0);
      setPositionType(PositionType.INTRADAY);
      setStoploss('');
      setTarget('');
      setLtp(0);
      setIsSubmitting(false);
      setEntryReason('');
      setEntryTags([]);
    }
  }, [isOpen]);

  const handleSubmit = async () => {
    if (!selectedInstrument || quantity <= 0) return;
    setIsSubmitting(true);
    try {
      await executeTrade({
        symbol: selectedInstrument.symbol,
        token: selectedInstrument.token,
        exchange: selectedInstrument.exchange,
        side,
        orderType,
        quantity,
        price: needsPrice ? price : undefined,
        triggerPrice: needsTrigger ? triggerPrice : undefined,
        positionType,
        stoploss: stoploss ? Number(stoploss) : undefined,
        target: target ? Number(target) : undefined,
        entryReason: entryReason.trim() || undefined,
        entryTags: entryTags.length > 0 ? entryTags : undefined,
      });
      onClose();
    } catch {
      // error handled in store
    } finally {
      setIsSubmitting(false);
    }
  };

  const isBuy = side === OrderSide.BUY;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Execute Trade" size="lg">
      <div className="space-y-4">
        {/* Paper indicator */}
        {isPaper && (
          <div className="flex items-center gap-2 rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-400">
            <AlertTriangle size={14} />
            Paper Trading Mode — this trade will be simulated
          </div>
        )}

        {/* Symbol search */}
        <div className="relative">
          <label className="block text-xs font-medium text-gray-400 mb-1">Symbol</label>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              value={symbol}
              onChange={(e) => handleSymbolChange(e.target.value)}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              placeholder="Search symbol..."
              className="w-full rounded-md border border-gray-700 bg-gray-800 py-2 pl-9 pr-3 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500"
            />
          </div>
          {showSuggestions && suggestions.length > 0 && (
            <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto rounded-md border border-gray-700 bg-gray-800 shadow-lg">
              {suggestions.map((inst) => (
                <button
                  key={`${inst.exchange}-${inst.token}`}
                  onClick={() => selectInstrument(inst)}
                  className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 flex items-center justify-between"
                >
                  <span className="font-medium">{inst.symbol}</span>
                  <span className="text-xs text-gray-500">{inst.exchange}</span>
                </button>
              ))}
            </div>
          )}
          {ltp > 0 && selectedInstrument && (
            <div className="mt-1 text-xs text-gray-400">
              LTP: <span className="text-[var(--color-text-primary)] font-medium">
                {ltp.toLocaleString('en-IN', { style: 'currency', currency: 'INR' })}
              </span>
            </div>
          )}
        </div>

        {/* Side toggle */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Side</label>
          <div className="flex rounded-md overflow-hidden border border-gray-700">
            {[OrderSide.BUY, OrderSide.SELL].map((s) => (
              <button
                key={s}
                onClick={() => setSide(s)}
                className={cn(
                  'flex-1 py-2 text-sm font-medium transition-colors',
                  side === s
                    ? s === OrderSide.BUY
                      ? 'bg-emerald-500/20 text-emerald-400'
                      : 'bg-red-500/20 text-red-400'
                    : 'text-gray-400 hover:bg-gray-700',
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Order type */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Order Type</label>
          <select
            value={orderType}
            onChange={(e) => setOrderType(e.target.value as OrderType)}
            className="w-full rounded-md border border-gray-700 bg-gray-800 py-2 px-3 text-sm text-gray-100 outline-none focus:border-blue-500"
          >
            <option value={OrderType.MARKET}>MARKET</option>
            <option value={OrderType.LIMIT}>LIMIT</option>
            <option value={OrderType.STOPLOSS}>SL</option>
            <option value={OrderType.STOPLOSS_MARKET}>SL-M</option>
          </select>
        </div>

        {/* Quantity + Price row */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Quantity</label>
            <input
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-full rounded-md border border-gray-700 bg-gray-800 py-2 px-3 text-sm text-gray-100 outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">
              Price {!needsPrice && <span className="text-gray-600">(N/A)</span>}
            </label>
            <input
              type="number"
              min={0}
              step={0.05}
              value={price}
              onChange={(e) => setPrice(parseFloat(e.target.value) || 0)}
              disabled={!needsPrice}
              className={cn(
                'w-full rounded-md border border-gray-700 bg-gray-800 py-2 px-3 text-sm text-gray-100 outline-none focus:border-blue-500',
                !needsPrice && 'opacity-40 cursor-not-allowed',
              )}
            />
          </div>
        </div>

        {/* Trigger price */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            Trigger Price {!needsTrigger && <span className="text-gray-600">(N/A)</span>}
          </label>
          <input
            type="number"
            min={0}
            step={0.05}
            value={triggerPrice}
            onChange={(e) => setTriggerPrice(parseFloat(e.target.value) || 0)}
            disabled={!needsTrigger}
            className={cn(
              'w-full rounded-md border border-gray-700 bg-gray-800 py-2 px-3 text-sm text-gray-100 outline-none focus:border-blue-500',
              !needsTrigger && 'opacity-40 cursor-not-allowed',
            )}
          />
        </div>

        {/* Position type toggle */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Position Type</label>
          <div className="flex rounded-md overflow-hidden border border-gray-700">
            {[PositionType.INTRADAY, PositionType.DELIVERY].map((pt) => (
              <button
                key={pt}
                onClick={() => setPositionType(pt)}
                className={cn(
                  'flex-1 py-2 text-sm font-medium transition-colors',
                  positionType === pt
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'text-gray-400 hover:bg-gray-700',
                )}
              >
                {pt}
              </button>
            ))}
          </div>
        </div>

        {/* SL / Target */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Stoploss (optional)</label>
            <input
              type="number"
              min={0}
              step={0.05}
              value={stoploss}
              onChange={(e) => setStoploss(e.target.value)}
              placeholder="--"
              className="w-full rounded-md border border-gray-700 bg-gray-800 py-2 px-3 text-sm text-gray-100 placeholder-gray-600 outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Target (optional)</label>
            <input
              type="number"
              min={0}
              step={0.05}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="--"
              className="w-full rounded-md border border-gray-700 bg-gray-800 py-2 px-3 text-sm text-gray-100 placeholder-gray-600 outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {/* M5: Why this trade — free-text rationale + tag chips */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            Why this trade?
          </label>
          <textarea
            value={entryReason}
            onChange={(e) => setEntryReason(e.target.value)}
            placeholder="What's your edge here? (free text)"
            rows={2}
            className="w-full rounded-md border border-gray-700 bg-gray-800 py-2 px-3 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500 resize-none"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {ENTRY_TAG_OPTIONS.map((tag) => {
              const active = entryTags.includes(tag.value);
              return (
                <button
                  key={tag.value}
                  type="button"
                  onClick={() =>
                    setEntryTags((prev) =>
                      prev.includes(tag.value)
                        ? prev.filter((t) => t !== tag.value)
                        : [...prev, tag.value],
                    )
                  }
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
                    active
                      ? 'border-blue-500 bg-blue-500/15 text-blue-300'
                      : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600',
                  )}
                >
                  {tag.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Estimated value + Risk */}
        <div className="rounded-md bg-gray-800/80 border border-gray-700/50 px-3 py-2 space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-400">Estimated Order Value</span>
            <span className="text-[var(--color-text-primary)] font-medium">
              {estimatedValue.toLocaleString('en-IN', { style: 'currency', currency: 'INR' })}
            </span>
          </div>
          {riskPercent > 80 && (
            <div className="flex items-center gap-1 text-xs text-amber-400">
              <AlertTriangle size={12} />
              Capital usage will exceed 80% of limit
            </div>
          )}
        </div>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={!selectedInstrument || quantity <= 0 || isSubmitting}
          className={cn(
            'w-full py-2.5 rounded-md text-sm font-semibold transition-colors flex items-center justify-center gap-2',
            isBuy
              ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
              : 'bg-red-600 hover:bg-red-500 text-white',
            (!selectedInstrument || isSubmitting) && 'opacity-50 cursor-not-allowed',
          )}
        >
          {isSubmitting ? (
            <Loader2 size={16} className="animate-spin" />
          ) : null}
          {isSubmitting ? 'Executing...' : `${side} ${symbol || 'Select Symbol'}`}
        </button>
      </div>
    </Modal>
  );
}
