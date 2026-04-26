import { useEffect, useState } from 'react';

// 12s represents a full sealed-bid round on Solana mainnet — multiple txs
// for commit, reveal, settle (not a single transfer). Set against the PER
// flow which clears the same logical work in ~5s with one settlement.
const AUCTION_DURATION_MS = 12_000;
const SETTLE_DELAY_MS = 2_000;
// ~6x the typical PER winning bid (~200k lamports) since a mainnet sealed-bid
// round is ~6 txs at mainnet fees, not one transfer.
const COST_LAMPORTS = 1_200_000;
const PROVIDERS = ['speedy', 'accurate', 'budget'];

type Phase = 'bidding' | 'cleared';

interface MainnetAuction {
  id: number;
  startedAt: number;
  bids: { providerName: string; amountLamports: number }[];
  phase: Phase;
  winnerName: string | null;
  sig: string | null;
}

function genBid(): number {
  // public bids around the ~6x-of-PER price point (1.0M – 1.4M lamports)
  return 1_000_000 + Math.floor(Math.random() * 400_000);
}

function fakeSig(): string {
  const HEX = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 40; i++) s += HEX[Math.floor(Math.random() * 16)];
  return s;
}

export function MainnetCard() {
  const [auction, setAuction] = useState<MainnetAuction>(() => ({
    id: 1,
    startedAt: Date.now(),
    bids: PROVIDERS.map((p) => ({ providerName: p, amountLamports: genBid() })),
    phase: 'bidding',
    winnerName: null,
    sig: null,
  }));
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(tick);
  }, []);

  // Lifecycle: bid window expires → clear → wait → restart
  useEffect(() => {
    const elapsed = now - auction.startedAt;
    if (auction.phase === 'bidding' && elapsed >= AUCTION_DURATION_MS) {
      const winner = [...auction.bids].sort((a, b) => a.amountLamports - b.amountLamports)[0];
      setAuction((a) => ({ ...a, phase: 'cleared', winnerName: winner.providerName, sig: fakeSig() }));
    }
    if (auction.phase === 'cleared' && elapsed >= AUCTION_DURATION_MS + SETTLE_DELAY_MS) {
      setAuction((a) => ({
        id: a.id + 1,
        startedAt: Date.now(),
        bids: PROVIDERS.map((p) => ({ providerName: p, amountLamports: genBid() })),
        phase: 'bidding',
        winnerName: null,
        sig: null,
      }));
    }
  }, [now, auction]);

  const remainingMs = Math.max(0, AUCTION_DURATION_MS - (now - auction.startedAt));
  const remainingSec = (remainingMs / 1000).toFixed(1);

  return (
    <div className="rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-3">
      <div className="flex justify-between items-baseline gap-2">
        <div className="text-zinc-300 text-sm font-semibold">mainnet auction #{auction.id}</div>
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">image-caption</div>
      </div>

      {auction.phase === 'bidding' ? (
        <>
          <div className="mt-2 text-zinc-100 mono text-2xl">{remainingSec}s</div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">remaining</div>

          <div className="mt-3 space-y-1.5">
            {auction.bids.map((b) => (
              <div
                key={b.providerName}
                className="flex justify-between items-baseline gap-2 bg-zinc-800/60 border border-zinc-700 rounded px-2 py-1"
              >
                <div className="text-zinc-300 text-xs">{b.providerName}</div>
                <div className="mono text-zinc-100 text-xs">
                  {b.amountLamports.toLocaleString()}{' '}
                  <span className="text-zinc-500">lamports</span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[10px] text-rose-400/80 italic">
            bids visible on chain (no privacy)
          </div>
        </>
      ) : (
        <div className="mt-2 space-y-0.5">
          <div className="text-emerald-400 text-xs font-semibold">winner: {auction.winnerName}</div>
          <div className="text-zinc-100 text-sm mono">
            {COST_LAMPORTS.toLocaleString()} <span className="text-zinc-500 text-xs">lamports</span>
          </div>
          <div className="mono text-[10px] text-zinc-500 truncate">sig {auction.sig?.slice(0, 24)}...</div>
          <div className="text-[10px] text-zinc-600 italic mt-1">round complete · ~6 txs settled on mainnet</div>
        </div>
      )}
    </div>
  );
}

export const MAINNET_AVG_COST_LAMPORTS = COST_LAMPORTS;
export const MAINNET_AUCTION_DURATION_MS = AUCTION_DURATION_MS;
