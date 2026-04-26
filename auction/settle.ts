import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { randomBytes } from 'crypto';
import { SOLANA_RPC_URL, CLUSTER } from '../config.js';

/**
 * Payment settlement.
 *
 * Two modes:
 *   - 'simulated': no chain call. Returns a fake signature. Zero risk, zero latency.
 *   - 'live':      real SOL transfer on Solana devnet (the "hero" settlement).
 *
 * The stage demo runs most auctions simulated, then one final hero auction live.
 * That gives us a real on-chain signature + explorer link to show on screen,
 * without exposing the whole demo to chain fragility.
 */

export interface SettleResult {
  sig: string;
  mode: 'simulated' | 'live';
  explorerUrl: string | null;
}

export async function settlePayment(params: {
  from: Keypair;
  to: PublicKey;
  lamports: number;
  jobId: string;
  mode: 'simulated' | 'live';
}): Promise<SettleResult> {
  if (params.mode === 'simulated') {
    const fakeSig = randomBytes(32).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
    return { sig: `sim_${fakeSig.slice(0, 16)}`, mode: 'simulated', explorerUrl: null };
  }

  // LIVE: real devnet SOL transfer with one retry on transient failure.
  // Each attempt builds a fresh Transaction so it picks up a fresh blockhash;
  // reusing the same tx would fail if the first attempt's blockhash expired.
  const conn = new Connection(SOLANA_RPC_URL, 'confirmed');

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: params.from.publicKey,
          toPubkey: params.to,
          lamports: params.lamports,
        }),
      );
      const sig = await sendAndConfirmTransaction(conn, tx, [params.from], {
        commitment: 'confirmed',
      });
      const explorerUrl = `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
      return { sig, mode: 'live', explorerUrl };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < 2) {
        console.error(`[settle] live tx attempt ${attempt} failed, retrying:`, lastErr.message);
      }
    }
  }
  throw lastErr ?? new Error('live settlement failed');
}
