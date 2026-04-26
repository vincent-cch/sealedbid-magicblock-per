import { useEffect, useMemo, useRef, useState } from 'react';

/* ─────────────────────────────────────────────────────────────────────────
 * Arcade view — pixel-art demo for the BD outreach video.
 *
 * Self-contained: opens its own WebSocket to ws://localhost:8787 (same as
 * the dashboard hook) and reads the full event stream including the
 * v2-rich events the dashboard's reducer drops (job-delegated,
 * bid-submitted, sponsor-funded, etc.). Animations are pure CSS keyframes
 * defined in index.html (.projectile / .coin / .vault-pulse / etc.) so
 * there's no animation library to bundle.
 *
 * Layout:
 *
 *  ┌─────────────────────────────────────────────────────────────────────┐
 *  │  HEADER — "SEALEDBID ARCADE" + mode badge                            │
 *  │                                                                       │
 *  │  ┌─speedy─┐    ┌─accurate─┐    ┌─budget─┐   ← ships row              │
 *  │     👾          🚀              ⚙️                                    │
 *  │                                                                       │
 *  │              ⬡ JOB #abc123  IMAGE-CAPTION ⬡  ← vault                 │
 *  │                  (glows magenta on L1, green on PER, cyan when       │
 *  │                   undelegated; flashes on each event)                │
 *  │                                                                       │
 *  │           [ projectiles fire from ships → vault ]                    │
 *  │           [ coin flies vault → winner on settle  ]                    │
 *  │                                                                       │
 *  │  ┌──── stats strip ────┐                                             │
 *  │  │ CLEARED  THROUGHPUT │                                             │
 *  │  │ AVG COST  WINNERS   │                                             │
 *  └─────────────────────────────────────────────────────────────────────┘
 *
 * ───────────────────────────────────────────────────────────────────────── */

const WS_URL = 'ws://localhost:8787';

// Provider config — keys MUST match `providerName` from the coordinator.
const SHIPS = [
  { name: 'speedy',   sprite: '👾', color: '#22d3ee', label: 'SPEEDY'   }, // cyan
  { name: 'accurate', sprite: '🚀', color: '#f0abfc', label: 'ACCURATE' }, // magenta
  { name: 'budget',   sprite: '⚙️', color: '#22c55e', label: 'BUDGET'   }, // neon green
] as const;

type ShipName = (typeof SHIPS)[number]['name'];

interface BidProjectile {
  id: string;
  shipIdx: number;
  amount: number;
  startedAt: number;
}

interface SettlementCoin {
  id: string;
  winnerIdx: number;
  amount: number;
  isUsdc: boolean;
  startedAt: number;
}

interface VaultState {
  jobId: string;
  taskType: string;
  phase: 'posted' | 'delegated' | 'undelegated' | 'closed';
  lastFlashAt: number;
  pulseAt: number;
}

interface Stats {
  cleared: number;
  totalSolPaid: number;
  totalUsdcMicro: number;
  startedAt: number;
  winners: Record<ShipName, number>;
}

const PROJECTILE_DUR_MS = 800;
const COIN_DUR_MS = 1100;
const SHIP_FIRE_MS = 350;

function shortJob(jobId: string): string {
  return jobId ? jobId.slice(0, 8).toUpperCase() : '——';
}

function shipIndexFor(name: string): number {
  return SHIPS.findIndex((s) => s.name === name);
}

export function Arcade() {
  const [connected, setConnected] = useState(false);
  const [vault, setVault] = useState<VaultState | null>(null);
  const [projectiles, setProjectiles] = useState<BidProjectile[]>([]);
  const [coins, setCoins] = useState<SettlementCoin[]>([]);
  const [winnerIdx, setWinnerIdx] = useState<number | null>(null);
  const [winnerLabelAt, setWinnerLabelAt] = useState<number>(0);
  const [firingShip, setFiringShip] = useState<{ idx: number; until: number } | null>(null);
  const [stats, setStats] = useState<Stats>({
    cleared: 0,
    totalSolPaid: 0,
    totalUsdcMicro: 0,
    startedAt: 0,
    winners: { speedy: 0, accurate: 0, budget: 0 },
  });

  // Force ticks for time-based UI (throughput counter, fade timers).
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 250);
    return () => window.clearInterval(id);
  }, []);

  // ── WebSocket subscription ──────────────────────────────────────────────
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
        setStats((s) => (s.startedAt ? s : { ...s, startedAt: Date.now() }));
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) reconnectTimer = window.setTimeout(connect, 1500);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          handleEvent(msg);
        } catch {
          /* ignore bad frames */
        }
      };
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  function handleEvent(msg: any): void {
    const now = Date.now();
    switch (msg.type) {
      case 'job-posted': {
        setVault({
          jobId: msg.jobId,
          taskType: msg.taskType,
          phase: 'posted',
          lastFlashAt: now,
          pulseAt: now,
        });
        // Reset winner banner from previous round so a new auction starts clean.
        setWinnerIdx(null);
        setWinnerLabelAt(0);
        break;
      }
      case 'job-delegated': {
        setVault((v) => (v ? { ...v, phase: 'delegated', lastFlashAt: now } : v));
        break;
      }
      case 'job-undelegated': {
        setVault((v) => (v ? { ...v, phase: 'undelegated', lastFlashAt: now } : v));
        break;
      }
      case 'bid-submitted': {
        const idx = shipIndexFor(msg.providerName);
        if (idx < 0) break;
        const id = `p-${msg.jobId}-${msg.providerName}-${now}`;
        setProjectiles((arr) => [
          ...arr,
          { id, shipIdx: idx, amount: msg.amountLamports ?? 0, startedAt: now },
        ]);
        setFiringShip({ idx, until: now + SHIP_FIRE_MS });
        // Sweep the projectile after its CSS animation finishes.
        window.setTimeout(() => {
          setProjectiles((arr) => arr.filter((p) => p.id !== id));
        }, PROJECTILE_DUR_MS + 100);
        break;
      }
      case 'auction-closed': {
        if (msg.winner) {
          const idx = shipIndexFor(msg.winner.providerName);
          if (idx >= 0) {
            setWinnerIdx(idx);
            setWinnerLabelAt(now);
            setStats((s) => ({
              ...s,
              winners: {
                ...s.winners,
                [msg.winner.providerName as ShipName]:
                  (s.winners[msg.winner.providerName as ShipName] ?? 0) + 1,
              },
            }));
          }
        }
        setVault((v) => (v ? { ...v, phase: 'closed', lastFlashAt: now } : v));
        break;
      }
      case 'settled': {
        const isUsdc = msg.mode === 'live-usdc-tee';
        const isLive = msg.mode === 'live-sol' || msg.mode === 'live-usdc-tee';
        if (winnerIdx !== null && isLive) {
          const id = `c-${msg.jobId}-${now}`;
          setCoins((arr) => [
            ...arr,
            {
              id,
              winnerIdx,
              amount: isUsdc ? (msg.usdcAmountMicro ?? 0) : (msg.amountLamports ?? 0),
              isUsdc,
              startedAt: now,
            },
          ]);
          window.setTimeout(() => {
            setCoins((arr) => arr.filter((c) => c.id !== id));
          }, COIN_DUR_MS + 100);
        }
        if (msg.winner && (isLive || msg.mode === 'simulated')) {
          setStats((s) => ({
            ...s,
            cleared: s.cleared + 1,
            totalSolPaid: isUsdc ? s.totalSolPaid : s.totalSolPaid + (msg.amountLamports ?? 0),
            totalUsdcMicro: isUsdc ? s.totalUsdcMicro + (msg.usdcAmountMicro ?? 0) : s.totalUsdcMicro,
          }));
        }
        break;
      }
      default:
        break;
    }
  }

  // ── Sprite positions (stable across renders, used for projectile math) ──
  // Ships are positioned in flex containers; we use ref-based measurement at
  // animation time. For the keyframe vars we just compute approximate offsets
  // from ship column index → vault center.
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const shipRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Throughput in cleared/sec since arcade connected.
  const throughput = useMemo(() => {
    if (!stats.startedAt) return 0;
    const elapsed = Math.max(1, (Date.now() - stats.startedAt) / 1000);
    return stats.cleared / elapsed;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats.cleared, stats.startedAt, /* tick */]);

  const avgSolPerAuction = stats.cleared > 0 ? stats.totalSolPaid / stats.cleared : 0;
  const winnerLabelVisible = winnerIdx !== null && Date.now() - winnerLabelAt < 5000;

  return (
    <div className="arcade w-full h-full overflow-hidden relative arcade-bg" ref={sceneRef}>
      {/* Three layers of parallax stars. */}
      <div className="stars" />
      <div className="stars2" />
      <div className="stars3" />

      {/* HEADER */}
      <div className="relative z-10 flex items-center justify-between px-8 py-4 border-b-2 border-fuchsia-500/40">
        <div className="flex items-baseline gap-4">
          <span className="text-fuchsia-400 text-xl">SEALEDBID</span>
          <span className="text-cyan-300 text-xl">ARCADE</span>
          <span className="text-zinc-500 text-[8px] tracking-widest">
            SEALED BID COMPUTE AUCTION · ON-CHAIN · TEE-PRIVATE
          </span>
        </div>
        <div
          className={`text-[8px] px-3 py-2 border-2 ${
            connected ? 'border-green-400 text-green-400' : 'border-red-400 text-red-400'
          }`}
        >
          {connected ? '● ONLINE' : '○ OFFLINE'}
        </div>
      </div>

      {/* SHIPS ROW */}
      <div className="relative z-10 grid grid-cols-3 gap-12 px-12 pt-10 pb-2">
        {SHIPS.map((ship, idx) => {
          const isWinner = winnerLabelVisible && winnerIdx === idx;
          const isLoser = winnerLabelVisible && winnerIdx !== null && winnerIdx !== idx;
          const isFiring = firingShip?.idx === idx && Date.now() < firingShip.until;
          return (
            <div
              key={ship.name}
              ref={(el) => (shipRefs.current[idx] = el)}
              className={`flex flex-col items-center ${isLoser ? 'loser-fade' : ''}`}
            >
              <div
                className={`text-7xl select-none ${isFiring ? 'ship-fire' : 'ship'}`}
                style={{ filter: `drop-shadow(0 0 12px ${ship.color}88)` }}
              >
                {ship.sprite}
              </div>
              <div
                className="mt-3 text-[10px] tracking-widest"
                style={{ color: ship.color }}
              >
                {ship.label}
              </div>
              <div className="mt-1 text-[7px] text-zinc-500">
                WINS: {String(stats.winners[ship.name as ShipName] ?? 0).padStart(3, '0')}
              </div>
              {isWinner && (
                <div
                  className="winner-banner mt-3 px-3 py-1 border-2 border-yellow-300 bg-yellow-300/10 text-yellow-200 text-[8px] tracking-widest"
                  style={{ textShadow: '0 0 6px #facc15' }}
                >
                  WINNER!
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* VAULT (center) */}
      <div className="relative z-10 flex items-center justify-center mt-6 mb-4">
        <Vault vault={vault} flashKey={vault?.lastFlashAt ?? 0} pulseKey={vault?.pulseAt ?? 0} />
      </div>

      {/* PROJECTILES + COINS overlay */}
      <Overlay
        sceneRef={sceneRef}
        shipRefs={shipRefs}
        projectiles={projectiles}
        coins={coins}
      />

      {/* STATS STRIP */}
      <div className="absolute bottom-0 left-0 right-0 z-10 border-t-2 border-fuchsia-500/40 bg-black/70 backdrop-blur px-8 py-4">
        <div className="grid grid-cols-4 gap-6 text-center">
          <Stat label="CLEARED" value={String(stats.cleared).padStart(4, '0')} color="#f0abfc" />
          <Stat
            label="THROUGHPUT"
            value={`${throughput.toFixed(2)}/S`}
            color="#22d3ee"
          />
          <Stat
            label="AVG SOL"
            value={
              stats.cleared > 0
                ? `${Math.round(avgSolPerAuction).toLocaleString()} L`
                : '—'
            }
            color="#22c55e"
          />
          <Stat
            label="USDC SCHED"
            value={
              stats.totalUsdcMicro > 0
                ? `${(stats.totalUsdcMicro / 1_000_000).toFixed(3)} USDC`
                : '—'
            }
            color="#facc15"
          />
        </div>
      </div>
    </div>
  );
}

/** Stats strip cell. */
function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div className="text-[7px] text-zinc-500 tracking-widest">{label}</div>
      <div className="text-base mt-1" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

/** Hex vault sprite. Color/glow varies by phase. */
function Vault({
  vault,
  flashKey,
  pulseKey,
}: {
  vault: VaultState | null;
  flashKey: number;
  pulseKey: number;
}) {
  const phase = vault?.phase ?? 'idle';
  const glowClass =
    phase === 'delegated'
      ? 'glow-green'
      : phase === 'undelegated' || phase === 'closed'
        ? 'glow-cyan'
        : 'glow-magenta';
  const phaseLabel =
    phase === 'delegated'
      ? 'PER · DELEGATED'
      : phase === 'undelegated'
        ? 'L1 · BACK'
        : phase === 'closed'
          ? 'CLOSED'
          : phase === 'posted'
            ? 'L1 · ESCROWED'
            : 'IDLE';
  const phaseColor = phase === 'delegated' ? '#22c55e' : phase === 'idle' ? '#71717a' : '#f0abfc';
  return (
    <div className="relative" style={{ width: 360 }}>
      <div
        className={`mx-auto vault-pulse ${glowClass}`}
        key={pulseKey}
        style={{
          width: 220,
          height: 220,
          clipPath: 'polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0% 50%)',
          background:
            phase === 'delegated'
              ? 'linear-gradient(135deg, #052e16 0%, #14532d 100%)'
              : 'linear-gradient(135deg, #1e0a3c 0%, #4a044e 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div className="vault-flash text-center" key={`flash-${flashKey}`} style={{ color: phaseColor }}>
          <div className="text-[10px] tracking-widest text-zinc-300">JOB</div>
          <div
            className="text-base mt-1"
            style={{ color: '#f0abfc', textShadow: '0 0 8px #d946ef99' }}
          >
            {vault ? `#${shortJob(vault.jobId)}` : '#--------'}
          </div>
          <div className="text-[8px] tracking-widest text-cyan-300 mt-3">
            {vault?.taskType?.toUpperCase() ?? 'AWAITING'}
          </div>
        </div>
      </div>
      <div className="text-center mt-3 text-[8px] tracking-widest" style={{ color: phaseColor }}>
        {phaseLabel}
      </div>
    </div>
  );
}

/**
 * Overlay layer — projectiles and coins. Uses bounding-rect math against the
 * ship and vault refs to compute --start-x / --end-x CSS vars per animation.
 */
function Overlay({
  sceneRef,
  shipRefs,
  projectiles,
  coins,
}: {
  sceneRef: React.RefObject<HTMLDivElement | null>;
  shipRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
  projectiles: BidProjectile[];
  coins: SettlementCoin[];
}) {
  // Resolve scene-relative coordinates for a DOM node's center.
  function center(el: HTMLElement | null): { x: number; y: number } | null {
    const scene = sceneRef.current;
    if (!el || !scene) return null;
    const a = el.getBoundingClientRect();
    const s = scene.getBoundingClientRect();
    return { x: a.left - s.left + a.width / 2, y: a.top - s.top + a.height / 2 };
  }

  // Resolve the vault's center via the DOM since we don't have a clean ref.
  // We use a query selector against the scene element; the vault is the only
  // element with the .vault-pulse class so this is unambiguous.
  function vaultCenter(): { x: number; y: number } | null {
    const scene = sceneRef.current;
    if (!scene) return null;
    const v = scene.querySelector('.vault-pulse') as HTMLElement | null;
    return center(v);
  }

  return (
    <div className="absolute inset-0 pointer-events-none z-20">
      {projectiles.map((p) => {
        const ship = shipRefs.current[p.shipIdx];
        const sc = center(ship);
        const vc = vaultCenter();
        if (!sc || !vc) return null;
        return (
          <div
            key={p.id}
            className="projectile"
            style={
              {
                position: 'absolute',
                left: sc.x,
                top: sc.y,
                ['--start-x' as any]: `0px`,
                ['--start-y' as any]: `0px`,
                ['--end-x' as any]: `${vc.x - sc.x}px`,
                ['--end-y' as any]: `${vc.y - sc.y}px`,
                ['--dur' as any]: `${PROJECTILE_DUR_MS}ms`,
                color: SHIPS[p.shipIdx].color,
                textShadow: `0 0 6px ${SHIPS[p.shipIdx].color}`,
                fontSize: 12,
                whiteSpace: 'nowrap',
                transform: `translate(-50%, -50%)`,
              } as React.CSSProperties
            }
          >
            <span style={{ fontFamily: "'Press Start 2P', monospace" }}>
              ▼ {p.amount.toLocaleString()}L
            </span>
          </div>
        );
      })}

      {coins.map((c) => {
        const ship = shipRefs.current[c.winnerIdx];
        const sc = center(ship);
        const vc = vaultCenter();
        if (!sc || !vc) return null;
        return (
          <div
            key={c.id}
            className="coin"
            style={
              {
                position: 'absolute',
                left: vc.x,
                top: vc.y,
                ['--end-x' as any]: `${sc.x - vc.x}px`,
                ['--end-y' as any]: `${sc.y - vc.y}px`,
                color: c.isUsdc ? '#22c55e' : '#facc15',
                textShadow: `0 0 10px ${c.isUsdc ? '#22c55e' : '#facc15'}`,
                fontSize: 18,
                whiteSpace: 'nowrap',
                transform: 'translate(-50%, -50%)',
              } as React.CSSProperties
            }
          >
            <span style={{ fontFamily: "'Press Start 2P', monospace" }}>
              {c.isUsdc ? '$' : '◎'}{' '}
              {c.isUsdc
                ? `${(c.amount / 1_000_000).toFixed(2)} USDC`
                : `${c.amount.toLocaleString()}L`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
