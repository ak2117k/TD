import SetupContextCard, { type AnalysisDto } from './SetupContextCard';
import LiveQuoteCard from './LiveQuoteCard';

interface Props {
  token: string;
  exchange: string;
  symbol: string;
  timeframe: string;
  analysis: AnalysisDto | null;
  analysisLoading: boolean;
}

/**
 * Scrollable info panel shown below the chart on /charts. Each card is
 * self-contained — its own hook, its own loading state — so a slow data
 * source (e.g. options chain) doesn't gate the cards above it.
 *
 * Cards (top → bottom):
 *   1. Setup & Context (lifted from the old floating AnalysisPanel)
 *   2. Live Quote
 *   3. Market Depth
 *   4. Indicators
 *   5. Options Chain Preview
 *   6. Symbol News
 *   7. Fundamentals (stub for now)
 *
 * Currently rendering placeholder slots — each lands in a follow-up commit.
 */
export default function StockOverviewPanel({
  token,
  exchange,
  symbol,
  analysis,
  analysisLoading,
}: Props) {
  return (
    <div className="flex flex-col gap-4 p-4 max-w-full">
      <SetupContextCard analysis={analysis} loading={analysisLoading} />
      <LiveQuoteCard token={token} exchange={exchange} symbol={symbol} />
      <PlaceholderCard label="Card 3: Market Depth (placeholder)" />
      <PlaceholderCard label="Card 4: Indicators (placeholder)" />
      <PlaceholderCard label="Card 5: Options Chain Preview (placeholder)" />
      <PlaceholderCard label="Card 6: News (placeholder)" />
      <PlaceholderCard label="Card 7: Fundamentals (placeholder)" />
    </div>
  );
}

function PlaceholderCard({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-500">
      {label}
    </div>
  );
}
