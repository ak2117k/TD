import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Send, Power, X, Inbox } from 'lucide-react';
import OrderTicket from '@/components/trading/OrderTicket';
import {
  useTradeStore,
  tradesToPositions,
  deriveCapitalDeployed,
} from '@/stores/trade-store';
import { wsService } from '@/services/websocket';
import api from '@/services/api';
import { cn } from '@/utils/cn';
import { TradeStatus, type Position, type Trade, type Quote } from '@/types';

// ---- formatting helpers (mirrors PositionsPage conventions) ----
function formatINR(amount: number, opts?: { withSign?: boolean }): string {
  const formatted = amount.toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  });
  if (opts?.withSign && amount > 0) return `+${formatted}`;
  return formatted;
}

function formatPrice(value: number): string {
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatTime(value: Date | string | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// ---- Risk strip ----
function RiskMetric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'good' | 'bad' | 'neutral';
}) {
  const valueColor =
    tone === 'good'
      ? 'text-emerald-400'
      : tone === 'bad'
        ? 'text-red-400'
        : 'text-[var(--color-text-primary)]';
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </span>
      <span className={cn('text-lg font-bold leading-tight', valueColor)}>
        {value}
      </span>
      {sub && (
        <span className="text-[11px] text-[var(--color-text-muted)]">{sub}</span>
      )}
    </div>
  );
}

function RiskStrip({
  onKillSwitch,
  killSwitchActive,
  capitalDeployed,
  positionsCount,
}: {
  onKillSwitch: () => void;
  killSwitchActive: boolean;
  // Derived from the MANUAL open trades (single source = DB), NOT the
  // in-memory position-manager that diverged and only counted one trade.
  capitalDeployed: number;
  positionsCount: number;
}) {
  // Limits (capitalLimit / dailyLossLimit / positionsLimit) still come from
  // /trades/risk-status — only the *used* values are derived from the page's
  // MANUAL open trades so the strip matches the panel + order book below.
  const riskStatus = useTradeStore((s) => s.riskStatus);

  const capitalPct =
    riskStatus.capitalLimit > 0
      ? (capitalDeployed / riskStatus.capitalLimit) * 100
      : 0;
  // Daily P&L: positive loss-used means a loss; expose it as a signed P&L.
  const dailyPnl = -(riskStatus.dailyLossUsed ?? 0);

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-5 py-3">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <RiskMetric
          label="Capital Deployed"
          value={formatINR(capitalDeployed ?? 0)}
          sub={`${capitalPct.toFixed(0)}% of ${formatINR(riskStatus.capitalLimit ?? 0)}`}
          tone={capitalPct >= 90 ? 'bad' : 'neutral'}
        />
        <RiskMetric
          label="Daily P&L"
          value={formatINR(dailyPnl, { withSign: true })}
          sub={`Limit ${formatINR(riskStatus.dailyLossLimit ?? 0)}`}
          tone={dailyPnl > 0 ? 'good' : dailyPnl < 0 ? 'bad' : 'neutral'}
        />
        <RiskMetric
          label="Positions"
          value={`${positionsCount} / ${riskStatus.positionsLimit ?? 0}`}
          sub="used / limit"
          tone={
            (riskStatus.positionsLimit ?? 0) > 0 &&
            positionsCount >= (riskStatus.positionsLimit ?? 0)
              ? 'bad'
              : 'neutral'
          }
        />
      </div>

      <button
        onClick={onKillSwitch}
        disabled={killSwitchActive}
        className={cn(
          'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-all',
          killSwitchActive
            ? 'cursor-not-allowed bg-red-500/10 text-red-400/50'
            : 'bg-red-500/15 text-red-400 hover:bg-red-500/25',
        )}
      >
        <Power size={16} />
        {killSwitchActive ? 'Squaring off…' : 'Kill Switch'}
      </button>
    </div>
  );
}

// ---- Positions panel ----
function PositionsPanel({
  positions,
  onExit,
}: {
  positions: Position[];
  onExit: (symbol: string) => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-3">
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
          Open Positions
        </h2>
        {positions.length > 0 && (
          <span className="text-xs text-[var(--color-text-muted)]">
            {positions.length} open
          </span>
        )}
      </div>

      {positions.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-[var(--color-text-muted)]">
          <Inbox size={28} />
          <span className="text-sm">No open positions</span>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[var(--color-border-subtle)] text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                <th className="px-4 py-2 font-medium">Symbol</th>
                <th className="px-4 py-2 font-medium">Side</th>
                <th className="px-4 py-2 font-medium text-right">Qty</th>
                <th className="px-4 py-2 font-medium text-right">Entry</th>
                <th className="px-4 py-2 font-medium text-right">LTP</th>
                <th className="px-4 py-2 font-medium text-right">P&amp;L</th>
                <th className="px-4 py-2 font-medium text-right" />
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const isProfit = p.pnl >= 0;
                return (
                  <tr
                    key={p.symbol}
                    className="border-b border-[var(--color-border-subtle)]/60 last:border-0 hover:bg-white/5"
                  >
                    <td className="px-4 py-2.5 text-sm font-medium text-[var(--color-text-primary)]">
                      {p.symbol}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                          p.side === 'BUY'
                            ? 'bg-emerald-500/15 text-emerald-400'
                            : 'bg-red-500/15 text-red-400',
                        )}
                      >
                        {p.side}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-sm text-[var(--color-text-secondary)]">
                      {p.quantity}
                    </td>
                    <td className="px-4 py-2.5 text-right text-sm text-[var(--color-text-secondary)]">
                      {formatPrice(p.averagePrice)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-sm text-[var(--color-text-secondary)]">
                      {formatPrice(p.ltp)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div
                        className={cn(
                          'text-sm font-semibold',
                          isProfit ? 'text-emerald-400' : 'text-red-400',
                        )}
                      >
                        {formatINR(p.pnl, { withSign: true })}
                      </div>
                      <div
                        className={cn(
                          'text-[11px]',
                          isProfit ? 'text-emerald-400/70' : 'text-red-400/70',
                        )}
                      >
                        {p.pnlPercent >= 0 ? '+' : ''}
                        {p.pnlPercent.toFixed(2)}%
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => onExit(p.symbol)}
                        className="inline-flex items-center gap-1 rounded-md bg-red-500/15 px-2.5 py-1 text-xs font-semibold text-red-400 transition-colors hover:bg-red-500/25"
                      >
                        <X size={12} />
                        Exit
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Order book ----
function statusTone(status: TradeStatus | string): string {
  switch (status) {
    case TradeStatus.OPEN:
    case TradeStatus.FILLED:
    case TradeStatus.PARTIALLY_FILLED:
      return 'bg-blue-500/15 text-blue-400';
    case TradeStatus.CLOSED:
      return 'bg-gray-500/15 text-gray-300';
    case TradeStatus.REJECTED:
    case TradeStatus.CANCELLED:
      return 'bg-red-500/15 text-red-400';
    case TradeStatus.PENDING:
      return 'bg-amber-500/15 text-amber-400';
    default:
      return 'bg-gray-500/15 text-gray-300';
  }
}

function OrderBookTable({ trades }: { trades: Trade[] }) {
  if (trades.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-[var(--color-text-muted)]">
        <Inbox size={28} />
        <span className="text-sm">No orders</span>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-[var(--color-border-subtle)] text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
            <th className="px-4 py-2 font-medium">Symbol</th>
            <th className="px-4 py-2 font-medium">Side</th>
            <th className="px-4 py-2 font-medium text-right">Qty</th>
            <th className="px-4 py-2 font-medium text-right">Price</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium text-right">Time</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr
              key={t.id}
              className="border-b border-[var(--color-border-subtle)]/60 last:border-0 hover:bg-white/5"
            >
              <td className="px-4 py-2.5 text-sm font-medium text-[var(--color-text-primary)]">
                {t.symbol}
              </td>
              <td className="px-4 py-2.5">
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                    t.side === 'BUY'
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : 'bg-red-500/15 text-red-400',
                  )}
                >
                  {t.side}
                </span>
              </td>
              <td className="px-4 py-2.5 text-right text-sm text-[var(--color-text-secondary)]">
                {t.quantity}
              </td>
              <td className="px-4 py-2.5 text-right text-sm text-[var(--color-text-secondary)]">
                {formatPrice(t.entryPrice ?? 0)}
              </td>
              <td className="px-4 py-2.5">
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                    statusTone(t.status),
                  )}
                >
                  {t.status}
                </span>
              </td>
              <td className="px-4 py-2.5 text-right text-xs text-[var(--color-text-muted)]">
                {formatTime(t.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OrderBook({ openTrades }: { openTrades: Trade[] }) {
  const [tab, setTab] = useState<'open' | 'recent'>('open');
  const [recent, setRecent] = useState<Trade[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get<Trade[]>('/trades?limit=20');
        if (!cancelled) setRecent(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setRecent([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const tabs: Array<{ key: 'open' | 'recent'; label: string }> = [
    { key: 'open', label: `Open (${openTrades.length})` },
    { key: 'recent', label: 'Recent' },
  ];

  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div className="flex items-center gap-1 border-b border-[var(--color-border-subtle)] px-3 py-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
              tab === t.key
                ? 'bg-[var(--color-accent-blue)]/15 text-[var(--color-accent-blue)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <OrderBookTable trades={tab === 'open' ? openTrades : recent} />
    </div>
  );
}

// ---- Page ----
export default function ManualTradePage() {
  const openTrades = useTradeStore((s) => s.openTrades);
  const isKillSwitchActive = useTradeStore((s) => s.isKillSwitchActive);
  const fetchOpenTrades = useTradeStore((s) => s.fetchOpenTrades);
  const fetchRiskStatus = useTradeStore((s) => s.fetchRiskStatus);
  const closeTrade = useTradeStore((s) => s.closeTrade);
  const closeAllPositions = useTradeStore((s) => s.closeAllPositions);

  // Live LTP overlay by symbol. Fed by the tick WS; merged onto the derived
  // positions for live P&L without round-tripping through the position-manager
  // store (which is no longer this page's source of truth).
  const [ltpBySymbol, setLtpBySymbol] = useState<Record<string, number>>({});

  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // Single source of truth for the whole page: the MANUAL open trades.
  // The top PositionsPanel, the Capital Deployed / Positions metrics, and the
  // bottom Order Book all derive from this list, so they cannot diverge.
  const positions = useMemo<Position[]>(() => {
    const base = tradesToPositions(openTrades as Trade[]);
    // Overlay live LTP (and recompute P&L) where we have a fresh tick.
    return base.map((p) => {
      const ltp = ltpBySymbol[p.symbol];
      if (typeof ltp !== 'number' || ltp === p.ltp) return p;
      const direction = p.side === 'BUY' ? 1 : -1;
      const pnl = (ltp - p.averagePrice) * p.quantity * direction;
      const cost = p.averagePrice * p.quantity;
      const pnlPercent = cost > 0 ? (pnl / cost) * 100 : 0;
      return { ...p, ltp, pnl, pnlPercent };
    });
  }, [openTrades, ltpBySymbol]);

  const capitalDeployed = useMemo(
    () => deriveCapitalDeployed(openTrades as Trade[]),
    [openTrades],
  );
  const positionsCount = openTrades.length;

  const refetchAll = useCallback(() => {
    fetchOpenTrades('MANUAL');
    fetchRiskStatus();
  }, [fetchOpenTrades, fetchRiskStatus]);

  // Initial load + 5s poll fallback (refetch the MANUAL open trades).
  useEffect(() => {
    refetchAll();
    pollRef.current = setInterval(() => {
      fetchOpenTrades('MANUAL');
    }, 5000);
    return () => {
      clearInterval(pollRef.current);
    };
  }, [refetchAll, fetchOpenTrades]);

  // Live LTP/P&L: capture each tick that matches a held symbol into the local
  // overlay. The `positions` memo recomputes P&L from it. We deliberately do
  // NOT write back to the position-manager store here — this page derives its
  // positions from openTrades, not /trades/positions.
  useEffect(() => {
    const unsubTick = wsService.subscribe('tick', (data) => {
      const q = data as Quote;
      if (!q?.symbol || typeof q.ltp !== 'number') return;
      setLtpBySymbol((prev) =>
        prev[q.symbol] === q.ltp ? prev : { ...prev, [q.symbol]: q.ltp },
      );
    });
    return () => {
      unsubTick();
    };
  }, []);

  const handleKillSwitch = useCallback(() => {
    if (
      window.confirm(
        'Kill switch will immediately square off ALL open positions. Continue?',
      )
    ) {
      closeAllPositions();
    }
  }, [closeAllPositions]);

  // Position has no trade id — match by symbol against openTrades (same
  // mapping PositionsPage uses) to resolve the closable trade id.
  const handleExit = useCallback(
    (symbol: string) => {
      const trade = openTrades.find((t) => t.symbol === symbol);
      if (trade) {
        closeTrade(trade.id);
      } else {
        // No open trade row to map; still refetch so the panel reconciles.
        refetchAll();
      }
    },
    [openTrades, closeTrade, refetchAll],
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Send size={24} className="text-[var(--color-accent-blue)]" />
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
          Manual Trade
        </h1>
      </div>

      {/* Risk strip */}
      <RiskStrip
        onKillSwitch={handleKillSwitch}
        killSwitchActive={isKillSwitchActive}
        capitalDeployed={capitalDeployed}
        positionsCount={positionsCount}
      />

      {/* Two-column workspace */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(320px,420px)_1fr]">
        {/* Left: order ticket */}
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
          <OrderTicket variant="panel" onSubmitted={refetchAll} />
        </div>

        {/* Right: positions + order book */}
        <div className="space-y-5">
          <PositionsPanel positions={positions} onExit={handleExit} />
          <OrderBook openTrades={openTrades} />
        </div>
      </div>
    </div>
  );
}
