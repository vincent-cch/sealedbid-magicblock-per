// WebSocket server for the on-chain auction demo. Streams the live auction
// firehose to any connected browser. The v1 React UI consumes four event
// types: job-posted, bids-sealed, auction-closed, settled — we keep those
// names and shapes stable so ui/ runs unchanged. The richer on-chain event
// stream (sponsor-funded, job-delegated, bid-submitted, bid-rejected) is
// also forwarded for any client that wants it; v1 UI ignores unknown types.

import 'dotenv/config';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import {
  OnchainAuctionCoordinator,
  type AuctionResult,
  type ProviderEntry,
  type TaskTypeName,
} from './auction/onchain-coordinator.js';

const PORT = 8787;
const STAGGER_MS = 8000; // ~8s between starts; an auction takes ~6–8s end-to-end
const MAX_IN_FLIGHT = 1; // strictly sequential — keeps devnet happy and the UI readable
const MIN_REQUESTER_BALANCE_SOL = 0.05; // bail out if the requester is too poor

const BASE_RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const EPHEMERAL_RPC_URL =
  process.env.MAGICBLOCK_EPHEMERAL_RPC_URL ?? 'https://devnet-tee.magicblock.app';

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
});

// ─── WebSocket plumbing ─────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: PORT });
const clients = new Set<WebSocket>();

function broadcast(msg: object): void {
  const data = JSON.stringify(msg);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  }
}

function fakeEnvelope(): string {
  // Placeholder envelope hex for the v1 UI's bids-sealed payload. Real seal
  // crypto is out of scope for Level B — the privacy guarantee is the TEE
  // execution environment, not on-the-wire encryption.
  return '0x' + randomBytes(8).toString('hex');
}

// ─── Event translation: coordinator events → WS messages ────────────────────
//
// We forward each coordinator event to the WS, AND we synthesize the v1-shape
// `bids-sealed` and `settled` events so ui/ keeps working unchanged.

const bidsSealedSent = new Set<string>(); // jobId set, so we only emit bids-sealed once

coordinator.on('job-posted', (e: any) => {
  // Forward raw event for any rich client.
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
  broadcast({
    type: 'job-undelegated',
    jobId: e.jobId,
    ts: e.ts,
  });
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
  // PER, not after the auction clears. Use placeholder envelope hex matching
  // the number of providers we expect to bid (UI doesn't validate the count).
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
  // v1 auction-closed payload (winner shape).
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

// L1 settlement event. Coordinator emits this after the auction-closed event
// once the SystemProgram.transfer requester→winner has either landed or
// failed. The v1 UI consumes { jobId, sig, mode, explorerUrl } and treats
// mode='live' as the hero marker.
coordinator.on('settled', (s: any) => {
  broadcast({
    type: 'settled',
    jobId: s.jobId,
    sig: s.sig,
    mode: s.mode,
    explorerUrl: s.explorerUrl,
    // Extra fields the v1 UI ignores but rich clients can show:
    winner: s.winner,
    amountLamports: s.amountLamports,
    requesterRefundLamports: s.requesterRefundLamports,
    usdcAmountMicro: s.usdcAmountMicro,
    usdcScheduleSig: s.usdcScheduleSig,
    error: s.error,
    ts: s.ts,
  });
});

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
    return true;
  } catch (err) {
    console.error('[server] startup balance check failed:', err);
    return false;
  }
}

async function startAuctionLoop(): Promise<void> {
  if (running) return;
  running = true;
  console.log('[server] auction loop starting');

  while (running && clients.size > 0) {
    if (inFlight >= MAX_IN_FLIGHT) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    const i = counter++;
    const taskType = TASK_TYPES[i % TASK_TYPES.length];

    inFlight++;
    coordinator
      .runAuction({
        taskType,
        providers,
        maxBidLamports: 800_000,
        windowMs: 5000,
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
  console.log('[server] auction loop stopped (no clients)');
}

// ─── Server bootstrap ───────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[server] client connected (${clients.size} total)`);
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[server] client disconnected (${clients.size} remaining)`);
  });
  ws.on('error', (err) => console.error('[server] ws error:', err));
  if (!running) startAuctionLoop();
});

console.log(`[server] WebSocket on ws://localhost:${PORT}`);
console.log(`[server] requester: ${requesterKp.publicKey.toBase58()}`);
console.log(`[server] base RPC : ${BASE_RPC_URL}`);
console.log(`[server] PER  RPC : ${EPHEMERAL_RPC_URL}`);

const ok = await startup();
if (!ok) {
  console.error('[server] startup failed — exiting');
  process.exit(1);
}
console.log('[server] ready — waiting for browser to connect…');
