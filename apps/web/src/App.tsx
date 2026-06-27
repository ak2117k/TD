import { useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { AppLayout } from '@/components/layout';
import { wsService } from '@/services/websocket';
import DashboardPage from '@/pages/dashboard/DashboardPage';
import ChartsPage from '@/pages/charts/ChartsPage';
import MarketPage from '@/pages/market/MarketPage';
import OptionsPage from '@/pages/options/OptionsPage';
import SignalsPage from '@/pages/signals/SignalsPage';
import RejectionsPage from '@/pages/signals/RejectionsPage';
import ChartinkPage from '@/pages/chartink/ChartinkPage';
import AutoTradePage from '@/pages/auto-trade/AutoTradePage';
import ManualTradePage from '@/pages/manual-trade/ManualTradePage';
import PositionsPage from '@/pages/positions/PositionsPage';
import NewsPage from '@/pages/news/NewsPage';
import JournalPage from '@/pages/journal/JournalPage';
import AdvisorPage from '@/pages/advisor/AdvisorPage';
import BacktestPage from '@/pages/backtest/BacktestPage';
import StrategyBuilderPage from '@/pages/strategy-builder/StrategyBuilderPage';
import { StrategyReviewPage } from '@/pages/strategy-review/StrategyReviewPage';
import SettingsPage from '@/pages/settings/SettingsPage';
import { WatchPage } from '@/pages/watch/WatchPage';
import { UngatedWatchPage } from '@/pages/ungated-watch/UngatedWatchPage';
import { AdaptiveStopPage } from '@/pages/adaptive-stop/AdaptiveStopPage';
import IntradayPage from '@/pages/intraday/IntradayPage';
import SwingPage from '@/pages/swing/SwingPage';
import BreakoutSwingPage from '@/pages/breakout-swing/BreakoutSwingPage';
import { SellFuturesPage } from '@/pages/sell-futures/SellFuturesPage';
import ReinvestPage from '@/pages/reinvest/ReinvestPage';

export default function App() {
  // Open the live-data WebSocket once at app boot. wsService.connect() is
  // idempotent — repeat calls are no-ops once sockets are open. Without
  // this, only the AutoTrade page (which calls connect itself) would
  // ever bring up live ticks; charts and signals would silently fall
  // back to historical-only data and require a page refresh to pick up
  // anything new.
  useEffect(() => {
    wsService.connect();
  }, []);

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="charts" element={<ChartsPage />} />
        <Route path="market" element={<MarketPage />} />
        <Route path="options" element={<OptionsPage />} />
        <Route path="signals" element={<SignalsPage />} />
        <Route path="rejections" element={<RejectionsPage />} />
        <Route path="chartink" element={<ChartinkPage />} />
        <Route path="watch" element={<WatchPage />} />
        <Route path="ungated-watch" element={<UngatedWatchPage />} />
        <Route path="adaptive-stop" element={<AdaptiveStopPage />} />
        <Route path="intraday" element={<IntradayPage />} />
        <Route path="swing" element={<SwingPage />} />
        <Route path="breakout-swing" element={<BreakoutSwingPage />} />
        <Route path="sell-futures" element={<SellFuturesPage />} />
        <Route path="reinvest" element={<ReinvestPage />} />
        <Route path="auto-trade" element={<AutoTradePage />} />
        <Route path="manual-trade" element={<ManualTradePage />} />
        <Route path="positions" element={<PositionsPage />} />
        <Route path="news" element={<NewsPage />} />
        <Route path="journal" element={<JournalPage />} />
        <Route path="advisor" element={<AdvisorPage />} />
        <Route path="backtest" element={<BacktestPage />} />
        <Route path="strategy-builder" element={<StrategyBuilderPage />} />
        <Route path="strategy-review" element={<StrategyReviewPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
