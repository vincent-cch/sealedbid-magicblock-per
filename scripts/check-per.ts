import 'dotenv/config';
import { Connection } from '@solana/web3.js';
import nacl from 'tweetnacl';
import {
  getAuthToken,
  verifyTeeRpcIntegrity,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import { loadWallet } from './load-wallet.js';
import { MAGICBLOCK_EPHEMERAL_RPC_URL, TEE_VALIDATOR } from '../config.js';

/**
 * Level A milestones 1 + 2: PER health check.
 * Canonical pattern from MAGICBLOCK-PER-KNOWLEDGE-PACK.md §4.
 *   1) verifyTeeRpcIntegrity(rpcUrl)
 *   2) getAuthToken(rpcUrl, wallet.publicKey, signMessage)
 *   3) open ephemeral Connection with `?token=...` and run getVersion + getSlot
 * PASS only if all four succeed. FAIL with full error details on any failure.
 */

async function main() {
  console.log('=== MagicBlock PER health check ===');
  console.log('Ephemeral RPC :', MAGICBLOCK_EPHEMERAL_RPC_URL);
  console.log('TEE validator :', TEE_VALIDATOR.toBase58());

  const requester = loadWallet('requester');
  console.log('Requester     :', requester.publicKey.toBase58());

  // 0.11.x: returns Promise<void>, throws on failure (no boolean to check).
  console.log('\n[1] verifyTeeRpcIntegrity(rpcUrl)');
  await verifyTeeRpcIntegrity(MAGICBLOCK_EPHEMERAL_RPC_URL);
  console.log('   result        : ok (TDX quote verified, reportData binds challenge)');

  console.log('\n[2] getAuthToken(rpcUrl, requester.publicKey, signMessage)');
  const auth = await getAuthToken(
    MAGICBLOCK_EPHEMERAL_RPC_URL,
    requester.publicKey,
    async (msg) => nacl.sign.detached(msg, requester.secretKey),
  );
  console.log('   token         :', auth.token.slice(0, 16) + '...');
  console.log('   expiresAt     :', new Date(auth.expiresAt).toISOString());

  console.log('\n[3] open ephemeral Connection with ?token=... → getVersion + getSlot');
  const ephemeralUrl = `${MAGICBLOCK_EPHEMERAL_RPC_URL}?token=${auth.token}`;
  const ephemeralRpc = new Connection(ephemeralUrl, 'confirmed');
  const version = await ephemeralRpc.getVersion();
  console.log('   getVersion    :', JSON.stringify(version));
  const slot = await ephemeralRpc.getSlot();
  console.log('   getSlot       :', slot);

  console.log('\n========================================');
  console.log('  PER CHECK: PASS');
  console.log('========================================');
  console.log('  rpc           :', MAGICBLOCK_EPHEMERAL_RPC_URL);
  console.log('  validator     :', TEE_VALIDATOR.toBase58());
  console.log('  requester     :', requester.publicKey.toBase58());
  console.log('  solana-core   :', version['solana-core'] ?? '(unknown)');
  console.log('  slot          :', slot);
}

main().catch((err) => {
  console.error('\n========================================');
  console.error('  PER CHECK: FAIL');
  console.error('========================================');
  console.error('  rpc       :', MAGICBLOCK_EPHEMERAL_RPC_URL);
  console.error('  validator :', TEE_VALIDATOR.toBase58());
  console.error('  error     :', err?.message ?? err);
  if (err?.cause) console.error('  cause     :', err.cause);
  if (err?.stack) console.error('\n', err.stack);
  process.exit(1);
});
