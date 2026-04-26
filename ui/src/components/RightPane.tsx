import { MainnetCard, MAINNET_AVG_COST_LAMPORTS, MAINNET_AUCTION_DURATION_MS } from './MainnetCard';
import { FeedStats } from '../hooks/useAuctionFeed';

interface Props {
  perStats: FeedStats;
}

export function RightPane({ perStats }: Props) {
  // mainnet baseline: 1 auction per ~40s, fixed cost
  const mainnetThroughput = 1 / (MAINNET_AUCTION_DURATION_MS / 1000);
  const mainnetAvgSol = MAINNET_AVG_COST_LAMPORTS / 1_000_000_000;

  // Cost comparison vs PER (avoid div-by-zero)
  const perAvg = perStats.cleared > 0 ? perStats.totalCostLamports / perStats.cleared : 0;
  const multiplier = perAvg > 0 ? MAINNET_AVG_COST_LAMPORTS / perAvg : 0;

  return (
    <div className="flex flex-col h-full min-w-0">
      <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div>
          <div className="text-zinc-100 font-semibold">Solana Mainnet (simulated)</div>
          <div className="text-zinc-500 text-xs">public bids, ~6 transactions per round</div>
        </div>
        <div className="text-[10px] mono px-2 py-0.5 rounded border border-zinc-700 text-zinc-400">
          PUBLIC
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
        <MainnetCard />
      </div>

      <footer className="border-t border-zinc-800 px-4 py-3 bg-zinc-950/60">
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Cleared</div>
            <div className="text-zinc-100 font-semibold mono">slow</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Auctions per second</div>
            <div className="text-zinc-100 font-semibold mono">{mainnetThroughput.toFixed(3)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Avg cost</div>
            <div className="text-zinc-100 font-semibold mono">{mainnetAvgSol.toFixed(6)} SOL</div>
            {multiplier > 1 && (
              <div className="text-[10px] mono text-rose-400">~6x more expensive</div>
            )}
          </div>
        </div>
        <div className="text-[11px] text-zinc-500 italic mt-2 leading-snug">
          Mainnet figure represents a full sealed-bid round, not a single transfer.
        </div>
      </footer>
    </div>
  );
}
