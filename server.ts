// WebSocket server for the on-chain auction demo. Streams the live auction
// firehose to any connected browser. The v1 React UI consumes four event
// types: job-posted, bids-sealed, auction-closed, settled — we keep those
// names and shapes stable so ui/ runs unchanged. The richer on-chain event
// stream (job-delegated, bid-submitted, bid-rejected, job-undelegated) is
// also forwarded for any client that wants it; v1 UI ignores unknown types.
//
// Behavior model (entry ab):
//   - Visitor-driven: auctions fire ONLY while at least one WebSocket
//     session is active (connected, not paused via Page Visibility, not
//     capped via the per-session limit). When all sessions go inactive,
//     the loop stops immediately. No idle work, no wasted SOL.
//   - Real auctions only. No synthetic / ghost / cached events.
//   - Per-session cap of MAX_PER_SESSION (default 100, ~13 min of activity).
//     Server emits `demo-idle` to that session and stops counting it as
//     active. UI shows "Demo paused — refresh to resume."
//   - Daily SOL floor: requester balance polled every BUDGET_POLL_MS. If
//     below SERVER_REQUESTER_FLOOR_SOL (env, default 0.5), pause the loop
//     globally and broadcast `demo-paused-budget`. Auto-resume +
//     `demo-resumed-budget` when balance recovers.
//   - Page Visibility integration: client sends `pause-session` /
//     `resume-session` JSON frames; server respects them per-session.

import 'dotenv/config';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import {
  OnchainAuctionCoordinator,
  type AuctionResult,
  type ProviderEntry,
  type SettlementModeOption,
  type TaskTypeName,
} from './auction/onchain-coordinator.js';

const PORT = 8787;
const STAGGER_MS = 6000; // ~6s between starts; matches the 8s bid window so cadence/window stay aligned
const MAX_IN_FLIGHT = 1; // strictly sequential — coordinator's provider agents share state, parallel mode produces no-valid-bids auctions
const MIN_REQUESTER_BALANCE_SOL = 0.05; // bail out at startup if requester is too poor

// Long-dwell protection (entry ab).
const MAX_PER_SESSION = Number(process.env.MAX_AUCTIONS_PER_SESSION ?? 100);
const SERVER_REQUESTER_FLOOR_SOL = Number(process.env.SERVER_REQUESTER_FLOOR_SOL ?? 1.0);
const BUDGET_POLL_MS = 60_000;

const BASE_RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const EPHEMERAL_RPC_URL =
  process.env.MAGICBLOCK_EPHEMERAL_RPC_URL ?? 'https://devnet-tee.magicblock.app';

/**
 * Settlement mode for the server's auction loop. Override via SETTLEMENT_MODE
 * env var. The default 'live-usdc-tee' assumes the requester wallet has USDC
 * for the transferSpl bundle; deployments without USDC should set this to
 * 'live-sol' (program-enforced SOL payout) so settle ix actually lands.
 *
 *   live-usdc-tee  → settle_auction_refund + transferSpl(private, TEE)
 *   live-sol       → settle_auction (program-signed SOL payout)
 *   simulated      → no settle ix; for stress / cold-start tests
 */
const VALID_MODES: SettlementModeOption[] = ['live-sol', 'live-usdc-tee', 'simulated'];
const SETTLEMENT_MODE = ((): SettlementModeOption => {
  const raw = (process.env.SETTLEMENT_MODE ?? 'live-usdc-tee').trim();
  if ((VALID_MODES as string[]).includes(raw)) return raw as SettlementModeOption;
  console.warn(
    `[server] SETTLEMENT_MODE='${raw}' is not one of ${VALID_MODES.join(' | ')} — falling back to 'live-usdc-tee'`,
  );
  return 'live-usdc-tee';
})();

const TASK_TYPES: TaskTypeName[] = ['image-caption', 'text-summarize', 'echo'];

// ─── Wallets ────────────────────────────────────────────────────────────────
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf-8'))));
}
const requesterKp = loadKeypair(path.join(projectRoot, 'wallets', 'requester.json'));
const providers: ProviderEntry[] = [
  {
    keypair: loadKeypair(path.join(projectRoot, 'wallets', 'provider-1.json')),
    name: 'speedy',
    pricing: { 'image-caption': 180_000, 'text-summarize': 400_000, echo: 350_000 },
  },
  {
    keypair: loadKeypair(path.join(projectRoot, 'wallets', 'provider-2.json')),
    name: 'accurate',
    pricing: { 'image-caption': 320_000, 'text-summarize': 220_000 },
  },
  {
    keypair: loadKeypair(path.join(projectRoot, 'wallets', 'provider-3.json')),
    name: 'budget',
    pricing: { 'image-caption': 280_000, echo: 150_000 },
  },
];

const coordinator = new OnchainAuctionCoordinator(requesterKp, {
  baseRpcUrl: BASE_RPC_URL,
  ephemeralRpcUrl: EPHEMERAL_RPC_URL,
  settlementMode: SETTLEMENT_MODE,
});

// ─── Session state ──────────────────────────────────────────────────────────
//
// Each WebSocket connection is its own session. The loop fires only while at
// least one session is `active` (not paused, not idle). Each session counts
// auctions independently — when its count hits MAX_PER_SESSION, it flips to
// `idle` and stops driving the loop.

interface SessionState {
  ws: WebSocket;
  auctionsServed: number;
  paused: boolean;
  idle: boolean;
}

const sessions = new Map<WebSocket, SessionState>();
let budgetLow = false;
let budgetCheckInflight = false;
let consecutiveSettleFailures = 0;
let settleBroken = false;
const providerBalanceCache = new Map<string, { lamports: number; fetchedAt: number }>();
const SETTLE_BREAKER_THRESHOLD = 3;
const SETTLE_PROBE_INTERVAL_MS = 10 * 60_000; // 10 min between auto-recovery probes
const PROVIDER_MIN_LAMPORTS = 5_000_000; // 0.005 SOL — auto-refill threshold
const PROVIDER_REFILL_LAMPORTS = 5_000_000; // top up by 0.005 SOL
const PROVIDER_BALANCE_CACHE_TTL_MS = 60_000;

function activeSessionCount(): number {
  let n = 0;
  for (const s of sessions.values()) {
    if (!s.paused && !s.idle) n++;
  }
  return n;
}

function shouldFire(): boolean {
  return !budgetLow && !settleBroken && activeSessionCount() > 0;
}

function sendTo(ws: WebSocket, msg: object): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* ignore — closing socket */
  }
}

function broadcast(msg: object): void {
  const data = JSON.stringify(msg);
  for (const c of sessions.keys()) {
    if (c.readyState === WebSocket.OPEN) {
      try { c.send(data); } catch { /* ignore */ }
    }
  }
}

function fakeEnvelope(): string {
  // Placeholder envelope hex for the v1 UI's bids-sealed payload. The privacy
  // guarantee is the TEE execution environment, not on-the-wire encryption,
  // so this is just visual chrome attached to a real on-chain auction.
  return '0x' + randomBytes(8).toString('hex');
}

// ─── Event translation: coordinator events → WS messages ────────────────────

const bidsSealedSent = new Set<string>(); // jobId set, so we only emit bids-sealed once

coordinator.on('job-posted', (e: any) => {
  broadcast({
    type: 'job-posted',
    jobId: e.jobId,
    description: e.description,
    taskType: e.taskType,
    maxBidLamports: e.maxBidLamports,
    sig: e.sig,
    explorerUrl: `https://explorer.solana.com/tx/${e.sig}?cluster=devnet`,
    ts: e.ts,
  });
});

coordinator.on('job-undelegated', (e: any) => {
  broadcast({ type: 'job-undelegated', jobId: e.jobId, ts: e.ts });
});

coordinator.on('job-delegated', (e: any) => {
  broadcast({
    type: 'job-delegated',
    jobId: e.jobId,
    sig: e.sig,
    explorerUrl: `https://explorer.solana.com/tx/${e.sig}?cluster=devnet`,
    ts: e.ts,
  });
  // v1 compat: flip the UI card into "bidding" phase as soon as the Job is in
  // PER. Placeholder envelope hex matches the number of providers we expect
  // to bid (UI doesn't validate the count).
  if (!bidsSealedSent.has(e.jobId)) {
    bidsSealedSent.add(e.jobId);
    broadcast({
      type: 'bids-sealed',
      jobId: e.jobId,
      envelopes: providers.map(() => fakeEnvelope()),
      ts: Date.now(),
    });
  }
});

coordinator.on('bid-submitted', (e: any) => {
  broadcast({
    type: 'bid-submitted',
    jobId: e.jobId,
    providerName: e.providerName,
    providerPubkey: e.providerPubkey instanceof PublicKey ? e.providerPubkey.toBase58() : e.providerPubkey,
    amountLamports: e.amountLamports,
    confidence: e.confidence,
    sig: e.sig,
    bidPda: e.bidPda instanceof PublicKey ? e.bidPda.toBase58() : e.bidPda,
    ts: e.ts,
  });
});

coordinator.on('bid-rejected', (e: any) => {
  broadcast({ type: 'bid-rejected', ...e });
});

coordinator.on('auction-closed', (r: AuctionResult) => {
  const winner = r.winner
    ? {
        provider: r.winner.provider.toBase58(),
        providerName: r.winner.providerName,
        amountLamports: r.winner.amountLamports,
      }
    : null;
  broadcast({
    type: 'auction-closed',
    jobId: r.jobId,
    winner,
    clearingMs: r.clearingMs,
    totalBids: r.totalBids,
    sigs: {
      postJob: r.sigs.postJob,
      delegateJob: r.sigs.delegateJob,
      submitBids: r.sigs.submitBids.map((sb) => ({
        providerName: sb.providerName,
        sig: sb.sig,
        bidPda: sb.bidPda.toBase58(),
      })),
    },
    ts: Date.now(),
  });
});

coordinator.on('settled', (s: any) => {
  if (s.mode === 'failed') {
    consecutiveSettleFailures++;
    console.error(`[server] settle failure #${consecutiveSettleFailures} (jobId=${s.jobId}): ${s.error}`);
    if (consecutiveSettleFailures >= SETTLE_BREAKER_THRESHOLD && !settleBroken) {
      settleBroken = true;
      console.error(`[server] CIRCUIT BREAKER TRIPPED — ${SETTLE_BREAKER_THRESHOLD} consecutive settle failures. Pausing loop.`);
      broadcast({
        type: 'demo-paused-settle-error',
        consecutiveFailures: consecutiveSettleFailures,
        threshold: SETTLE_BREAKER_THRESHOLD,
        ts: Date.now(),
      });
    }
  } else {
    if (consecutiveSettleFailures > 0) {
      console.log(`[server] settle recovered after ${consecutiveSettleFailures} failures`);
    }
    consecutiveSettleFailures = 0;
    if (settleBroken) {
      settleBroken = false;
      console.log(`[server] CIRCUIT BREAKER RESET — auctions resuming`);
      broadcast({ type: 'demo-resumed-settle', ts: Date.now() });
    }
  }
  broadcast({
    type: 'settled',
    jobId: s.jobId,
    sig: s.sig,
    mode: s.mode,
    explorerUrl: s.explorerUrl,
    winner: s.winner,
    amountLamports: s.amountLamports,
    requesterRefundLamports: s.requesterRefundLamports,
    usdcAmountMicro: s.usdcAmountMicro,
    usdcScheduleSig: s.usdcScheduleSig,
    error: s.error,
    ts: s.ts,
  });
});

// ─── Budget poller ──────────────────────────────────────────────────────────
// Polls the requester's SOL balance every BUDGET_POLL_MS. Flips budgetLow
// on/off and broadcasts demo-paused-budget / demo-resumed-budget so all
// connected clients can show / clear the wallet-refilling banner.

const baseConn = new Connection(BASE_RPC_URL, 'confirmed');

async function checkBudget(): Promise<void> {
  if (budgetCheckInflight) return;
  budgetCheckInflight = true;
  try {
    const lamports = await baseConn.getBalance(requesterKp.publicKey);
    const sol = lamports / LAMPORTS_PER_SOL;
    const wasLow = budgetLow;
    budgetLow = sol < SERVER_REQUESTER_FLOOR_SOL;
    if (budgetLow && !wasLow) {
      console.log(
        `[server] budget LOW: ${sol.toFixed(6)} SOL < ${SERVER_REQUESTER_FLOOR_SOL} floor — pausing all sessions`,
      );
      broadcast({ type: 'demo-paused-budget', balanceSol: sol, floorSol: SERVER_REQUESTER_FLOOR_SOL, ts: Date.now() });
    } else if (!budgetLow && wasLow) {
      console.log(`[server] budget RECOVERED: ${sol.toFixed(6)} SOL — resuming`);
      broadcast({ type: 'demo-resumed-budget', balanceSol: sol, ts: Date.now() });
      // Kick the loop in case clients are connected and waiting.
      if (!running) startAuctionLoop();
    }
  } catch (err) {
    console.error('[server] budget check failed:', err instanceof Error ? err.message : err);
  } finally {
    budgetCheckInflight = false;
  }
}

function probeBreakerRecovery(): void {
  if (!settleBroken) return;
  console.log('[server] breaker probe — auto-resetting after timeout, allowing 3 fresh attempts');
  consecutiveSettleFailures = 0;
  settleBroken = false;
  broadcast({ type: 'demo-resumed-settle', ts: Date.now() });
  if (!running && shouldFire()) startAuctionLoop();
}
setInterval(probeBreakerRecovery, SETTLE_PROBE_INTERVAL_MS);

setInterval(() => { checkBudget(); }, BUDGET_POLL_MS);

// ─── Auction loop ───────────────────────────────────────────────────────────
let running = false;
let counter = 0;
let inFlight = 0;

async function startup(): Promise<boolean> {
  console.log('[server] startup checks…');
  try {
    const conn = new Connection(BASE_RPC_URL, 'confirmed');
    const bal = await conn.getBalance(requesterKp.publicKey);
    const balSol = bal / LAMPORTS_PER_SOL;
    if (balSol < MIN_REQUESTER_BALANCE_SOL) {
      console.error(
        `[server] requester ${requesterKp.publicKey.toBase58()} has only ${balSol} SOL (min ${MIN_REQUESTER_BALANCE_SOL})`,
      );
      console.error('[server] cannot run on-chain auctions. Top up via https://faucet.solana.com');
      return false;
    }
    console.log(`[server] requester balance: ${balSol} SOL`);
    // Seed budgetLow from the startup balance so we don't fire the first
    // auction with a stale assumption.
    budgetLow = balSol < SERVER_REQUESTER_FLOOR_SOL;
    if (budgetLow) {
      console.log(`[server] balance ${balSol.toFixed(6)} SOL is below floor ${SERVER_REQUESTER_FLOOR_SOL} — auctions will hold until refill`);
    }
    return true;
  } catch (err) {
    console.error('[server] startup balance check failed:', err);
    return false;
  }
}

/** Per-auction bookkeeping. Counts toward each active session's cap and
 *  flips any session that just hit MAX_PER_SESSION to idle. */
function chargeAuctionToActiveSessions(): void {
  for (const [ws, s] of sessions) {
    if (s.paused || s.idle) continue;
    s.auctionsServed++;
    if (s.auctionsServed >= MAX_PER_SESSION) {
      s.idle = true;
      console.log(`[server] session hit cap (${MAX_PER_SESSION}) — sending demo-idle`);
      sendTo(ws, {
        type: 'demo-idle',
        reason: 'session-cap',
        cap: MAX_PER_SESSION,
        served: s.auctionsServed,
        ts: Date.now(),
      });
    }
  }
}

async function ensureProvidersFunded(): Promise<boolean> {
  const now = Date.now();
  for (const p of providers) {
    const key = p.keypair.publicKey.toBase58();
    try {
      let cached = providerBalanceCache.get(key);
      let bal: number;
      if (cached && now - cached.fetchedAt < PROVIDER_BALANCE_CACHE_TTL_MS && cached.lamports >= PROVIDER_MIN_LAMPORTS) {
        bal = cached.lamports;
      } else {
        bal = await baseConn.getBalance(p.keypair.publicKey);
        providerBalanceCache.set(key, { lamports: bal, fetchedAt: now });
      }
      if (bal < PROVIDER_MIN_LAMPORTS) {
        console.log(`[server] provider ${p.name} low (${bal} lamports) — auto-refilling`);
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: requesterKp.publicKey,
            toPubkey: p.keypair.publicKey,
            lamports: PROVIDER_REFILL_LAMPORTS,
          })
        );
        const sig = await sendAndConfirmTransaction(baseConn, tx, [requesterKp]);
        console.log(`[server] refilled ${p.name}: ${sig}`);
        providerBalanceCache.set(key, { lamports: bal + PROVIDER_REFILL_LAMPORTS, fetchedAt: Date.now() });
      }
    } catch (err) {
      console.error(`[server] provider check failed for ${p.name}:`, err instanceof Error ? err.message : err);
      providerBalanceCache.delete(key);
      return false;
    }
  }
  return true;
}

async function startAuctionLoop(): Promise<void> {
  if (running) return;
  running = true;
  console.log('[server] auction loop starting');

  while (running && shouldFire()) {
    const fundsOk = await ensureProvidersFunded();
    if (!fundsOk) {
      console.warn('[server] provider funding check failed — sleeping 10s');
      await new Promise(r => setTimeout(r, 10000));
      continue;
    }
    if (inFlight >= MAX_IN_FLIGHT) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }

    const i = counter++;
    const taskType = TASK_TYPES[i % TASK_TYPES.length];

    chargeAuctionToActiveSessions();

    inFlight++;
    coordinator
      .runAuction({
        taskType,
        providers,
        maxBidLamports: 800_000,
        windowMs: 8000,
        description: `${taskType} #${i + 1}`,
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[server] auction ${i + 1} (${taskType}) failed: ${msg}`);
      })
      .finally(() => {
        inFlight--;
      });

    await new Promise((r) => setTimeout(r, STAGGER_MS));
  }

  running = false;
  if (budgetLow) {
    console.log('[server] auction loop stopped (budget below floor)');
  } else if (activeSessionCount() === 0) {
    console.log('[server] auction loop stopped (no active sessions)');
  } else {
    console.log('[server] auction loop stopped');
  }
}

// ─── WS server bootstrap ────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
  const state: SessionState = { ws, auctionsServed: 0, paused: false, idle: false };
  sessions.set(ws, state);
  console.log(`[server] client connected (${sessions.size} total, ${activeSessionCount()} active)`);

  // If we're currently paused for budget, tell the new client immediately so
  // they can show the banner without waiting for the next poll.
  if (budgetLow) {
    sendTo(ws, {
      type: 'demo-paused-budget',
      reason: 'budget',
      floorSol: SERVER_REQUESTER_FLOOR_SOL,
      ts: Date.now(),
    });
  }

  ws.on('message', (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    const s = sessions.get(ws);
    if (!s) return;
    switch (msg.type) {
      case 'pause-session':
        if (!s.paused) {
          s.paused = true;
          console.log(`[server] session paused (${activeSessionCount()} active remaining)`);
        }
        break;
      case 'resume-session':
        if (s.paused) {
          s.paused = false;
          console.log(`[server] session resumed (${activeSessionCount()} active)`);
          if (!running && shouldFire()) startAuctionLoop();
        }
        break;
      default:
        // Ignore unknown control messages.
        break;
    }
  });

  ws.on('close', () => {
    sessions.delete(ws);
    console.log(`[server] client disconnected (${sessions.size} remaining, ${activeSessionCount()} active)`);
  });
  ws.on('error', (err) => console.error('[server] ws error:', err));

  if (!running && shouldFire()) startAuctionLoop();
});

console.log(`[server] WebSocket on ws://localhost:${PORT}`);
console.log(`[server] requester: ${requesterKp.publicKey.toBase58()}`);
console.log(`[server] base RPC : ${BASE_RPC_URL}`);
console.log(`[server] PER  RPC : ${EPHEMERAL_RPC_URL}`);
console.log(`[server] settle   : ${SETTLEMENT_MODE}`);
console.log(`[server] caps     : ${MAX_PER_SESSION} auctions/session, ${SERVER_REQUESTER_FLOOR_SOL} SOL floor`);

const ok = await startup();
if (!ok) {
  console.error('[server] startup failed — exiting');
  process.exit(1);
}
console.log('[server] ready — waiting for browser to connect…');
