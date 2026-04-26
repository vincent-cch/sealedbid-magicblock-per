import { Keypair } from '@solana/web3.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { WALLETS_DIR } from '../config.js';

/**
 * Generate 1 requester wallet + 3 provider wallets. Saves to ./wallets/*.json.
 * Run once per fresh env.
 */

const AGENTS = ['requester', 'provider-1', 'provider-2', 'provider-3'] as const;

function main() {
  if (!existsSync(WALLETS_DIR)) mkdirSync(WALLETS_DIR, { recursive: true });

  for (const name of AGENTS) {
    const path = `${WALLETS_DIR}/${name}.json`;
    if (existsSync(path)) {
      console.log(`skip ${name}: already exists`);
      continue;
    }
    const kp = Keypair.generate();
    writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
    console.log(`${name}: ${kp.publicKey.toBase58()}`);
  }

  console.log('\ndone. fund these with: npm run fund-wallets');
}

main();
