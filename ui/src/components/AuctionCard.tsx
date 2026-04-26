import { useEffect, useState } from 'react';
import { AuctionState } from '../types';

const HEX = '0123456789abcdef';
function scrambleHex(len: number): string {
  let s = '0x';
  for (let i = 0; i < len; i++) s += HEX[Math.floor(Math.random() * 16)];
  return s;
}

export function AuctionCard({ auction }: { auction: AuctionState }) {
  const [scrambled, setScrambled] = useState<string[]>(auction.envelopes);

  useEffect(() => {
    if (auction.phase !== 'bidding') return;
    const tick = window.setInterval(() => {
      setScrambled(auction.envelopes.map(() => scrambleHex(14)));
    }, 100);
    return () => window.clearInterval(tick);
  }, [auction.phase, auction.envelopes.length]);

  // Phase-driven card chrome.
  const border =
    auction.hero
      ? 'border-fuchsia-500'
      : auction.phase === 'cleared'
        ? 'border-emerald-500/60'
        : auction.phase === 'bidding'
          ? 'border-yellow-400/70'
          : 'border-zinc-700';

  const containerClass = [
    'rounded-md border bg-zinc-900/70 px-3 py-2 mb-2 animate-in',
    border,
    auction.phase === 'cleared' ? 'flash-green' : '',
    auction.removing ? 'fading-out' : '',
  ].join(' ');

  return (
    <div className={containerClass}>
      <div className="flex justify-between items-baseline gap-2">
        <div className="text-[11px] mono text-zinc-500 truncate">job {auction.jobId.slice(0, 8)}</div>
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">{auction.taskType}</div>
      </div>
      <div className="text-sm text-zinc-200 truncate mt-0.5">{auction.description}</div>

      {auction.phase === 'posted' && (
        <div className="mt-1 text-xs text-zinc-500 italic">3 bidders incoming...</div>
      )}

      {auction.phase === 'bidding' && (
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {(scrambled.length ? scrambled : auction.envelopes).map((env, i) => (
            <div
              key={i}
              className="mono text-[11px] text-zinc-300 bg-zinc-800/80 border border-zinc-700 rounded px-1.5 py-1 truncate text-center"
            >
              {env}
            </div>
          ))}
        </div>
      )}

      {auction.phase === 'cleared' && auction.winner && (
        <div className="mt-2 space-y-0.5">
          <div className="flex justify-between items-baseline gap-2">
            <div className="text-emerald-400 text-xs font-semibold">
              winner: {auction.winner.providerName}
            </div>
            <div className="mono text-[10px] text-zinc-500">
              {auction.winner.provider.slice(0, 6)}...{auction.winner.provider.slice(-4)}
            </div>
          </div>
          <div className="flex justify-between items-baseline gap-2">
            <div className="text-zinc-200 text-sm">
              {auction.winner.amountLamports.toLocaleString()} <span className="text-zinc-500 text-xs">lamports</span>
            </div>
            <div className="text-zinc-500 text-[10px]">{auction.clearingMs}ms</div>
          </div>
          {auction.settlement && (() => {
            const s = auction.settlement;
            const settleSig = s.sig;
            const settleUrl =
              s.explorerUrl ?? (settleSig ? `https://explorer.solana.com/tx/${settleSig}?cluster=devnet` : null);
            const usdcUrl = s.usdcScheduleSig
              ? `https://explorer.solana.com/tx/${s.usdcScheduleSig}?cluster=devnet`
              : null;
            const failed = s.mode === 'failed';

            return (
              <div className="mt-1 flex flex-col gap-0.5">
                {failed && (
                  <span className="mono text-[10px] text-rose-400 font-semibold">SETTLEMENT FAILED</span>
                )}
                {!failed && settleSig && settleUrl && (
                  <a
                    href={settleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-400 hover:text-purple-300 hover:underline text-xs uppercase tracking-wider inline-block cursor-pointer"
                  >
                    ON-CHAIN SETTLEMENT →
                  </a>
                )}
                {usdcUrl && (
                  <a
                    href={usdcUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-400 hover:text-purple-300 hover:underline text-xs uppercase tracking-wider inline-block cursor-pointer"
                  >
                    USDC SCHEDULE →
                  </a>
                )}
                {!failed && !settleSig && !usdcUrl && (
                  <span className="mono text-[10px] text-zinc-500 italic">awaiting settlement…</span>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {auction.phase === 'cleared' && !auction.winner && (
        <div className="mt-1 text-xs text-zinc-600 italic">no valid bids</div>
      )}
    </div>
  );
}
