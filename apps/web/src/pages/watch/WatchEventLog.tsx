import type { WatchEvent } from '../../types/watch.types';

interface Props { events: WatchEvent[] }

const EVENT_LABEL: Record<string, string> = {
  INITIAL: 'INITIAL',
  PRICE_CHANGE: 'PRICE',
  SCORE_CHANGE: 'SCORE',
  TARGET_HIT: 'TARGET HIT',
  SL_HIT_SCORE: 'SL (score)',
  SL_HIT_PRICE: 'SL (price)',
  TRADE_OPENED: 'TRADE OPENED',
  TRADE_CLOSED: 'TRADE CLOSED',
  DISMISSED: 'DISMISSED',
};

function ts(s: string): string {
  const d = new Date(s);
  return d.toLocaleTimeString('en-IN', { hour12: false }) + ' ' +
    d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

export function WatchEventLog({ events }: Props) {
  if (events.length === 0) return <div className="text-sm text-gray-500">No events yet.</div>;
  return (
    <div className="text-xs font-mono space-y-1">
      {events.map((e) => (
        <div key={e.id} className="flex gap-3 items-baseline">
          <span className="text-gray-500 w-32 shrink-0">{ts(e.createdAt)}</span>
          <span className="w-24 shrink-0 text-blue-700">{EVENT_LABEL[e.eventType] ?? e.eventType}</span>
          <span className="grow">
            {e.price != null && <>₹{e.price.toFixed(2)} </>}
            {e.score != null && <>score={e.score} </>}
            {e.priceDelta != null && <>Δ={e.priceDelta.toFixed(2)}% </>}
            {e.scoreDelta != null && <>(Δscore={e.scoreDelta > 0 ? '+' : ''}{e.scoreDelta}) </>}
            {e.notes && <span className="text-gray-500">— {e.notes}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
