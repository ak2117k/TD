import { useState } from 'react';
import { Search, Globe, Wifi, WifiOff } from 'lucide-react';
import { useMarketStore } from '@/stores/market-store';
import { useWatchlist } from '@/hooks/useWatchlist';
import {
  IndicesBar,
  StockTable,
  WatchlistPanel,
  SectorHeatmap,
  MarketBreadth,
} from '@/components/trading';

type Tab = 'all' | 'fno' | 'commodities' | 'watchlist';

const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: 'All Stocks' },
  { key: 'fno', label: 'F&O' },
  { key: 'commodities', label: 'Commodities' },
  { key: 'watchlist', label: 'My Watchlist' },
];

export default function MarketPage() {
  const [activeTab, setActiveTab] = useState<Tab>('all');
  const [searchText, setSearchText] = useState('');
  const [exchangeFilter, setExchangeFilter] = useState('ALL');
  const isConnected = useMarketStore((s) => s.isConnected);
  const { watchlist } = useWatchlist();

  const exchangeForTab = (() => {
    if (activeTab === 'fno') return 'NFO';
    if (activeTab === 'commodities') return 'MCX';
    if (exchangeFilter !== 'ALL') return exchangeFilter;
    return undefined;
  })();

  const watchlistSymbols = activeTab === 'watchlist' ? watchlist.map((w) => w.symbol) : undefined;

  return (
    <div className="flex flex-col gap-4">
      {/* Header Row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Globe size={22} className="text-[var(--color-accent-blue)]" />
          <h1 className="text-xl font-bold text-[var(--color-text-primary)]">Market Overview</h1>
        </div>
        <div className="flex items-center gap-2">
          {isConnected ? (
            <span className="flex items-center gap-1.5 text-xs text-[var(--color-accent-green)]">
              <Wifi size={12} />
              Live
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-[var(--color-accent-red)]">
              <WifiOff size={12} />
              Disconnected
            </span>
          )}
        </div>
      </div>

      {/* Indices Bar */}
      <IndicesBar />

      {/* Search Bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-1 items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-3 py-2">
          <Search size={14} className="shrink-0 text-[var(--color-text-muted)]" />
          <input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search stocks, indices, commodities..."
            className="w-full min-w-0 bg-transparent text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]"
          />
        </div>
        {activeTab === 'all' && (
          <select
            value={exchangeFilter}
            onChange={(e) => setExchangeFilter(e.target.value)}
            className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs text-[var(--color-text-secondary)] outline-none"
          >
            <option value="ALL">All Exchanges</option>
            <option value="NSE">NSE</option>
            <option value="BSE">BSE</option>
            <option value="MCX">MCX</option>
            <option value="NFO">NFO</option>
          </select>
        )}
      </div>

      {/* Main Content */}
      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Left Panel - 70% */}
        <div className="flex flex-col gap-0 lg:w-[70%]">
          {/* Tabs */}
          <div className="flex gap-0 border-b border-[var(--color-border-subtle)]">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-2.5 text-xs font-semibold transition-colors ${
                  activeTab === tab.key
                    ? 'border-b-2 border-[var(--color-accent-blue)] text-[var(--color-accent-blue)]'
                    : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Stock Table */}
          <div className="rounded-b-xl border border-t-0 border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]">
            <StockTable
              filter={searchText}
              exchangeFilter={exchangeForTab}
              watchlistSymbols={watchlistSymbols}
            />
          </div>
        </div>

        {/* Right Panel - 30% */}
        <div className="flex flex-col gap-4 lg:w-[30%]">
          <WatchlistPanel />
          <MarketBreadth />
        </div>
      </div>

      {/* Bottom: Sector Heatmap */}
      <SectorHeatmap />
    </div>
  );
}
