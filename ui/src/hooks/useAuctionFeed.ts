import { useEffect, useRef, useState } from 'react';
import { AuctionState, ServerMessage } from '../types';

const WS_URL = 'ws://localhost:8787';
// Keep the last MAX_CLEARED completed auctions visible forever (or until
// they fall out the bottom of the rolling window). The dashboard's left
// pane uses this stack to show throughput contrast vs the simulated
// mainnet pane: at any moment the audience should see ~8 PER auctions
// already cleared next to 1 mainnet auction still grinding.
const MAX_CLEARED = 8;
// MAX_VISIBLE = MAX_CLEARED + a little headroom for in-progress (typically
// 1 posted + 0-1 bidding). Anything beyond that shouldn't exist in steady
// state, but the cap prevents the array from growing unbounded if the
// server-side auto-loop ever overlaps phases.
const MAX_VISIBLE = MAX_CLEARED + 4;
// Time window for fade-out of cards that fall out the bottom. Used only as
// the CSS animation duration for the `removing` state — the actual prune
// is count-based, not time-based, so the audience always sees
// MAX_CLEARED completed cards regardless of cadence.
const PRUNE_DELAY_MS = 600;

export interface FeedStats {
  cleared: number;
  totalCostLamports: number;
  startedAt: number | null;
}

export function useAuctionFeed() {
  const [auctions, setAuctions] = useState<AuctionState[]>([]);
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState<FeedStats>({ cleared: 0, totalCostLamports: 0, startedAt: null });
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stopped = false;
    let reconnectTimer: number | undefined;

    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setStats((s) => ({ ...s, startedAt: s.startedAt ?? Date.now() }));
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) reconnectTimer = window.setTimeout(connect, 1500);
      };
      ws.onerror = () => ws.close();

      ws.onmessage = (evt) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }
        applyMessage(msg);
      };
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  function applyMessage(msg: ServerMessage) {
    setAuctions((prev) => {
      switch (msg.type) {
        case 'job-posted': {
          const next: AuctionState = {
            jobId: msg.jobId,
            description: msg.description,
            taskType: msg.taskType,
            phase: 'posted',
            envelopes: [],
            winner: null,
            clearingMs: null,
            settlement: null,
            postedAt: msg.ts,
            closedAt: null,
            hero: false,
          };
          const trimmed = [next, ...prev].slice(0, MAX_VISIBLE);
          return trimmed;
        }
        case 'bids-sealed': {
          return prev.map((a) =>
            a.jobId === msg.jobId ? { ...a, phase: 'bidding', envelopes: msg.envelopes } : a,
          );
        }
        case 'auction-closed': {
          const updated = prev.map((a) =>
            a.jobId === msg.jobId
              ? { ...a, phase: 'cleared' as const, winner: msg.winner, clearingMs: msg.clearingMs, closedAt: msg.ts }
              : a,
          );
          // Count-based prune: keep only the newest MAX_CLEARED non-removing
          // cleared cards visible. Anything older gets `removing: true`,
          // which triggers the fade-out animation; the sweep effect drops
          // them from the DOM after the animation finishes.
          const cleared = updated.filter((a) => a.phase === 'cleared' && !a.removing);
          if (cleared.length <= MAX_CLEARED) return updated;
          const overflow = new Set(cleared.slice(MAX_CLEARED).map((a) => a.jobId));
          return updated.map((a) =>
            overflow.has(a.jobId) ? { ...a, removing: true } : a,
          );
        }
        case 'settled': {
          return prev.map((a) =>
            a.jobId === msg.jobId
              ? {
                  ...a,
                  settlement: { sig: msg.sig, mode: msg.mode, explorerUrl: msg.explorerUrl },
                  // v1 emitted mode 'live' for on-chain settlements; v2 emits
                  // 'live-sol' / 'live-usdc-tee'. All three signal "real on-chain"
                  // settlement and should mark the card as hero. Cast to string
                  // because v1's ServerMessage union doesn't know about the
                  // v2 modes; we don't want to widen the type and force a UI refactor.
                  hero: ((msg.mode as string) === 'live' || (msg.mode as string) === 'live-sol' || (msg.mode as string) === 'live-usdc-tee') || a.hero,
                }
              : a,
          );
        }
        // v2 OnchainAuctionCoordinator emits richer event types that v1 UI
        // doesn't render: sponsor-funded, job-delegated, bid-submitted,
        // bid-rejected, close-auction-failed. The reducer must return prev
        // unchanged for unknown types, otherwise React stores `undefined`
        // and the next render crashes on `auctions.length`.
        default:
          return prev;
      }
    });

    if (msg.type === 'auction-closed' && msg.winner) {
      setStats((s) => ({
        cleared: s.cleared + 1,
        totalCostLamports: s.totalCostLamports + msg.winner!.amountLamports,
        startedAt: s.startedAt ?? Date.now(),
      }));
    }
  }

  // Sweep cards that have been in the `removing` state long enough for the
  // CSS fade-out animation to finish. Pruning to MAX_CLEARED happens inside
  // the auction-closed reducer; this effect just removes already-faded
  // cards from the DOM.
  useEffect(() => {
    const tick = window.setInterval(() => {
      setAuctions((prev) => {
        const next = prev.filter((a) => !a.removing);
        return next.length === prev.length ? prev : next;
      });
    }, PRUNE_DELAY_MS);
    return () => window.clearInterval(tick);
  }, []);

  return { auctions, connected, stats };
}
