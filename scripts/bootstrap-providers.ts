import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { pathToFileURL } from 'url';
import { CLUSTER, SOLANA_RPC_URL } from '../config.js';
import { loadWallet } from './load-wallet.js';

/**
 * Self-healing provider bootstrap.
 *
 * 1. SOL seeding — Solana refuses transfers to accounts below rent-exempt
 *    minimum, so the very first settlement to a fresh provider crashes with
 *    "insufficient funds for rent." Seed each provider with 0.002 SOL.
 * 2. (optional) USDC ATA creation — `live-usdc-tee` settlement requires each
 *    provider to have an existing USDC ATA (transferSpl is called with
 *    initIfMissing:false / initAtasIfMissing:false). If a provider's ATA is
 *    missing, the schedule tx fails. Pre-create them here.
 *
 * Both legs are idempotent. Called from demo-run.ts before any auction loop
 * runs, and from fund-wallets.ts.
 */

export const PROVIDER_NAMES = ['provider-1', 'provider-2', 'provider-3'] as const;
export const SEED_LAMPORTS = 2_000_000; // 0.002 SOL — comfortably above rent-exempt min
const FEE_BUFFER_LAMPORTS = 10_000; // per-tx headroom

// Devnet USDC (Circle). Mirrors the constant in auction/onchain-coordinator.ts.
const USDC_DEVNET_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

export async function bootstrapProviders(
  opts: { quiet?: boolean; ensureUsdcAtas?: boolean } = {},
): Promise<void> {
  const log = (msg: string) => {
    if (!opts.quiet) console.log(msg);
  };

  if (CLUSTER !== 'devnet') {
    log(`[bootstrap] cluster is ${CLUSTER}, skipping provider seeding`);
    return;
  }

  const conn = new Connection(SOLANA_RPC_URL, 'confirmed');
  const requester = loadWallet('requester');

  // Find which providers actually need seeding.
  const needSeed: { name: string; pubkey: ReturnType<typeof loadWallet>['publicKey'] }[] = [];
  for (const name of PROVIDER_NAMES) {
    const provider = loadWallet(name);
    const bal = await conn.getBalance(provider.publicKey);
    if (bal === 0) needSeed.push({ name, pubkey: provider.publicKey });
  }

  if (needSeed.length === 0) {
    log('[bootstrap] all providers already on chain, nothing to seed');
    return;
  }

  // Sanity-check requester balance before attempting any transfers, so we fail
  // with a clear, actionable error instead of a cryptic SendTransactionError.
  const requesterBal = await conn.getBalance(requester.publicKey);
  const needed = needSeed.length * (SEED_LAMPORTS + FEE_BUFFER_LAMPORTS);
  if (requesterBal < needed) {
    throw new Error(
      `requester wallet has ${requesterBal} lamports but needs ~${needed} to seed ${needSeed.length} provider(s). ` +
        `fund it via https://faucet.solana.com (address: ${requester.publicKey.toBase58()})`,
    );
  }

  if (needSeed.length > 0) {
    log(`[bootstrap] seeding ${needSeed.length} provider(s) with ${SEED_LAMPORTS} lamports each`);
    for (const { name, pubkey } of needSeed) {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: requester.publicKey,
          toPubkey: pubkey,
          lamports: SEED_LAMPORTS,
        }),
      );
      const sig = await sendAndConfirmTransaction(conn, tx, [requester], { commitment: 'confirmed' });
      log(`[bootstrap]   ${name}: seeded (sig ${sig.slice(0, 16)}...)`);
    }
  } else {
    log('[bootstrap] all providers already on chain, nothing to seed');
  }

  // ── USDC ATA creation (only when caller asks; live-usdc-tee mode) ─────
  if (!opts.ensureUsdcAtas) return;

  const missingAtas: { name: string; ata: PublicKey; owner: PublicKey }[] = [];
  for (const name of [...PROVIDER_NAMES, 'requester'] as const) {
    const wallet = loadWallet(name);
    const ata = getAssociatedTokenAddressSync(USDC_DEVNET_MINT, wallet.publicKey);
    const info = await conn.getAccountInfo(ata, 'confirmed');
    if (!info) missingAtas.push({ name, ata, owner: wallet.publicKey });
  }

  if (missingAtas.length === 0) {
    log('[bootstrap] USDC ATAs already exist for all wallets');
    return;
  }

  log(`[bootstrap] creating ${missingAtas.length} missing USDC ATA(s)`);
  for (const { name, ata, owner } of missingAtas) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        requester.publicKey, // payer
        ata,
        owner,
        USDC_DEVNET_MINT,
      ),
    );
    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [requester], { commitment: 'confirmed' });
      log(`[bootstrap]   ${name}: USDC ATA created (sig ${sig.slice(0, 16)}...)`);
    } catch (err) {
      // Race tolerant: if another process created it between our check and
      // our send, swallow the error and move on.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already in use')) {
        log(`[bootstrap]   ${name}: USDC ATA already created (race)`);
      } else {
        throw err;
      }
    }
  }
}

// CLI entry: `npx tsx scripts/bootstrap-providers.ts` or `npm run bootstrap`
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  bootstrapProviders().catch((err) => {
    console.error('[bootstrap] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
