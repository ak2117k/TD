import { Routes, Route } from 'react-router-dom';
import { AppLayout } from '@/components/layout';
import DashboardPage from '@/pages/dashboard/DashboardPage';
import ChartsPage from '@/pages/charts/ChartsPage';
import MarketPage from '@/pages/market/MarketPage';
import OptionsPage from '@/pages/options/OptionsPage';
import SignalsPage from '@/pages/signals/SignalsPage';
import AutoTradePage from '@/pages/auto-trade/AutoTradePage';
import PositionsPage from '@/pages/positions/PositionsPage';
import NewsPage from '@/pages/news/NewsPage';
import JournalPage from '@/pages/journal/JournalPage';
import AdvisorPage from '@/pages/advisor/AdvisorPage';
import BacktestPage from '@/pages/backtest/BacktestPage';
import StrategyBuilderPage from '@/pages/strategy-builder/StrategyBuilderPage';
import SettingsPage from '@/pages/settings/SettingsPage';

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="charts" element={<ChartsPage />} />
        <Route path="market" element={<MarketPage />} />
        <Route path="options" element={<OptionsPage />} />
        <Route path="signals" element={<SignalsPage />} />
        <Route path="auto-trade" element={<AutoTradePage />} />
        <Route path="positions" element={<PositionsPage />} />
        <Route path="news" element={<NewsPage />} />
        <Route path="journal" element={<JournalPage />} />
        <Route path="advisor" element={<AdvisorPage />} />
        <Route path="backtest" element={<BacktestPage />} />
        <Route path="strategy-builder" element={<StrategyBuilderPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
