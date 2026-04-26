import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { readFileSync, readdirSync } from 'fs';
import { SOLANA_RPC_URL, WALLETS_DIR, CLUSTER } from '../config.js';
import { bootstrapProviders } from './bootstrap-providers.js';

/**
 * Airdrop 1 SOL to every generated wallet on devnet.
 * Devnet airdrops are rate-limited; on failure use https://faucet.solana.com manually.
 *
 * After airdrops, also runs bootstrapProviders() — this seeds providers from the
 * requester so they exist on chain even when devnet refuses to airdrop directly
 * to them (which is the common case during busy periods).
 */

async function main() {
  if (CLUSTER !== 'devnet') {
    console.error(`refusing to airdrop on ${CLUSTER}. set SOLANA_CLUSTER=devnet.`);
    process.exit(1);
  }

  const conn = new Connection(SOLANA_RPC_URL, 'confirmed');
  const files = readdirSync(WALLETS_DIR).filter((f) => f.endsWith('.json'));

  for (const file of files) {
    const secret = JSON.parse(readFileSync(`${WALLETS_DIR}/${file}`, 'utf8'));
    const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
    const pubkey = kp.publicKey;

    try {
      const bal = await conn.getBalance(pubkey);
      if (bal >= 0.5 * LAMPORTS_PER_SOL) {
        console.log(`${file}: already has ${bal / LAMPORTS_PER_SOL} SOL`);
        continue;
      }

      const sig = await conn.requestAirdrop(pubkey, LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, 'confirmed');
      console.log(`${file}: airdropped 1 SOL to ${pubkey.toBase58()}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${file}: ${msg}`);
      console.error('  fallback: https://faucet.solana.com');
    }
  }

  // Self-heal: even if provider airdrops failed, seed them from the requester
  // so on-chain settlement works.
  try {
    await bootstrapProviders();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bootstrap] ${msg}`);
  }
}

main().catch(console.error);
