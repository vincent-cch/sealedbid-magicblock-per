import { useEffect, useState } from 'react';
import { LeftPane } from './components/LeftPane';
import { RightPane } from './components/RightPane';
import { Arcade } from './components/Arcade';
import { DemoBanner } from './components/DemoBanner';
import { useAuctionFeed } from './hooks/useAuctionFeed';

/** Read the route from window.location.hash. Empty / "#/" → dashboard. */
function useHashRoute(): string {
  const [route, setRoute] = useState<string>(() =>
    typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : '',
  );
  useEffect(() => {
    const onHashChange = () => setRoute(window.location.hash.replace(/^#/, ''));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return route;
}

export default function App() {
  const route = useHashRoute();

  // /arcade route → fully separate scene. Keeps the institutional dashboard
  // untouched; the arcade view opens its own WebSocket and renders nothing
  // from LeftPane/RightPane.
  if (route === '/arcade' || route === 'arcade') {
    return <Arcade />;
  }

  return <Dashboard />;
}

function Dashboard() {
  const { auctions, connected, stats, idleReason } = useAuctionFeed();

  // Force re-render every ~250ms so throughput counter ticks even when no events arrive.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((x) => x + 1), 250);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="h-full flex flex-col bg-zinc-950 text-zinc-100">
      <DemoBanner reason={idleReason} />
      <header className="flex items-center justify-between px-6 py-3 border-b border-zinc-800 bg-zinc-950">
        <div className="flex items-baseline gap-3">
          <div className="text-xl font-bold tracking-tight">SealedBid</div>
          <div className="text-zinc-500 text-xs">sealed-bid compute auctions for AI agents</div>
        </div>
        <div className="text-[10px] mono px-2 py-1 rounded border border-fuchsia-500/60 text-fuchsia-400">
          LIVE DEMO
        </div>
      </header>

      <main className="flex-1 grid grid-cols-2 min-h-0">
        <LeftPane auctions={auctions} connected={connected} stats={stats} />
        <RightPane perStats={stats} />
      </main>
    </div>
  );
}
