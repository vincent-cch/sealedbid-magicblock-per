import { AuctionState } from '../types';
import { AuctionCard } from './AuctionCard';
import { FeedStats } from '../hooks/useAuctionFeed';

interface Props {
  auctions: AuctionState[];
  connected: boolean;
  stats: FeedStats;
}

// Visual opacity tier for the Nth completed card from the top.
// Newest 3 = full opacity; next 3 = 70%; rest = 40%. Tunable in one place.
function clearedOpacity(index: number): number {
  if (index <= 2) return 1;
  if (index <= 5) return 0.7;
  return 0.4;
}

export function LeftPane({ auctions, connected, stats }: Props) {
  const elapsedSec = stats.startedAt ? Math.max(1, (Date.now() - stats.startedAt) / 1000) : 1;
  const throughput = stats.cleared / elapsedSec;
  const avgLamports = stats.cleared > 0 ? stats.totalCostLamports / stats.cleared : 0;
  const avgSol = avgLamports / 1_000_000_000;

  // Partition: in-progress (posted | bidding) at the top, then cleared
  // history (newest first per the reducer's prepend order). The hook caps
  // the cleared array at MAX_CLEARED so we don't need to slice here.
  const inProgress = auctions.filter((a) => a.phase !== 'cleared');
  const cleared = auctions.filter((a) => a.phase === 'cleared');

  return (
    <div className="flex flex-col h-full border-r border-zinc-800 min-w-0">
      <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div>
          <div className="text-zinc-100 font-semibold">MagicBlock PER (live)</div>
          <div className="text-zinc-500 text-xs">sealed-bid auctions clearing in real time</div>
        </div>
        <div className={`text-[10px] mono px-2 py-0.5 rounded border ${connected ? 'border-emerald-500/50 text-emerald-400' : 'border-rose-500/50 text-rose-400'}`}>
          {connected ? 'CONNECTED' : 'CONNECTING...'}
        </div>
      </header>

      <div className="flex-1 px-4 py-3 min-h-0 overflow-hidden">
        {auctions.length === 0 ? (
          <div className="text-zinc-600 text-sm italic">waiting for first auction...</div>
        ) : (
          <>
            {inProgress.map((a) => (
              <AuctionCard key={a.jobId} auction={a} />
            ))}
            {cleared.length > 0 && inProgress.length > 0 && (
              <div className="text-[10px] uppercase tracking-wider text-zinc-600 mt-2 mb-1">
                cleared history
              </div>
            )}
            {cleared.map((a, i) => (
              <div
                key={a.jobId}
                style={{ opacity: clearedOpacity(i), transition: 'opacity 400ms ease-out' }}
              >
                <AuctionCard auction={a} />
              </div>
            ))}
          </>
        )}
      </div>

      <footer className="border-t border-zinc-800 px-4 py-3 bg-zinc-950/60">
        <div className="grid grid-cols-3 gap-3 text-sm">
          <Stat label="Cleared" value={stats.cleared.toLocaleString()} />
          <Stat label="Auctions per second" value={throughput.toFixed(2)} />
          <Stat label="Avg cost" value={`${avgSol.toFixed(6)} SOL`} sub={`${Math.round(avgLamports).toLocaleString()} lamports`} />
        </div>
      </footer>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-zinc-100 font-semibold mono">{value}</div>
      {sub && <div className="text-[10px] mono text-zinc-600">{sub}</div>}
    </div>
  );
}
