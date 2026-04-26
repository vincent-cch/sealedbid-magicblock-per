import { Keypair } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { WALLETS_DIR } from '../config.js';

/**
 * Helper to load a keypair from ./wallets/<name>.json
 */
export function loadWallet(name: string): Keypair {
  const secret = JSON.parse(readFileSync(`${WALLETS_DIR}/${name}.json`, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}
