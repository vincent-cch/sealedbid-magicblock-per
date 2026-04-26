import 'dotenv/config';
import { readFileSync } from 'fs';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { Program, BN, AnchorProvider } from '@coral-xyz/anchor';

/**
 * Level B milestone-1 on-chain test.
 *
 * Verifies the deployed sealedbid program accepts:
 *   1. post_job (signed by requester)
 *   2. submit_bid (signed by provider-1)
 *
 * Runs against devnet base-layer RPC. Does NOT exercise the ephemeral RPC —
 * post_job + submit_bid in this first cut also delegate the PDAs to the TEE,
 * but the test only confirms the on-chain TX succeeds. Reading delegated
 * state through the ephemeral Connection is the next milestone.
 *
 * Pre-reqs: program built (`anchor build`) + deployed (`anchor deploy`),
 * IDL at target/idl/sealedbid.json, requester + provider-1 wallets funded
 * on devnet (npm run fund-wallets if needed).
 */

const SOLANA_RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey('5JaacAzrnjCwsigZxxHBDkiNuT2SQFG8xxMKVgyy629Q');

function loadKeypair(name: string): Keypair {
  const bytes = JSON.parse(readFileSync(`./wallets/${name}.json`, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function deriveJobPda(requester: PublicKey, jobNonce: BN): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('job'),
      requester.toBuffer(),
      jobNonce.toArrayLike(Buffer, 'le', 8),
    ],
    PROGRAM_ID,
  );
  return pda;
}

function deriveBidPda(jobPda: PublicKey, provider: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bid'), jobPda.toBuffer(), provider.toBuffer()],
    PROGRAM_ID,
  );
  return pda;
}

async function main() {
  const connection = new Connection(SOLANA_RPC, 'confirmed');
  const requester = loadKeypair('requester');
  const provider1 = loadKeypair('provider-1');

  console.log('=== Level B on-chain test ===');
  console.log('rpc       :', SOLANA_RPC);
  console.log('program   :', PROGRAM_ID.toBase58());
  console.log('requester :', requester.publicKey.toBase58());
  console.log('provider  :', provider1.publicKey.toBase58());

  // Sanity: balances
  const [reqBal, provBal] = await Promise.all([
    connection.getBalance(requester.publicKey),
    connection.getBalance(provider1.publicKey),
  ]);
  console.log(
    `\nbalances  : requester ${(reqBal / 1e9).toFixed(4)} SOL, provider ${(provBal / 1e9).toFixed(4)} SOL`,
  );
  if (reqBal < 0.05 * 1e9 || provBal < 0.05 * 1e9) {
    throw new Error(
      'requester or provider-1 balance < 0.05 SOL — run `npm run fund-wallets` first',
    );
  }

  // Load IDL produced by `anchor build`
  const idl = JSON.parse(readFileSync('./target/idl/sealedbid.json', 'utf8'));

  // Anchor provider — requester signs by default; we pass the provider keypair
  // explicitly when calling submit_bid.
  const requesterWallet = new anchor.Wallet(requester);
  const anchorProvider = new AnchorProvider(connection, requesterWallet, {
    commitment: 'confirmed',
  });
  anchor.setProvider(anchorProvider);
  const program = new Program(idl, anchorProvider);

  // ───── 1. post_job ─────────────────────────────────────────────────────
  const jobNonce = new BN(Date.now());
  const jobPda = deriveJobPda(requester.publicKey, jobNonce);
  const deadline = new BN(Math.floor(Date.now() / 1000) + 60);

  console.log('\n[1] post_job');
  console.log('   job pda    :', jobPda.toBase58());
  console.log('   job_nonce  :', jobNonce.toString());
  console.log('   deadline   :', new Date(deadline.toNumber() * 1000).toISOString());

  const postJobSig = await program.methods
    .postJob({
      taskType: 0,
      maxBid: new BN(1_000_000),
      deadline,
      jobNonce,
    })
    .accounts({
      requester: requester.publicKey,
      job: jobPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([requester])
    .rpc();
  console.log('   tx         :', postJobSig);
  console.log('   explorer   : https://explorer.solana.com/tx/' + postJobSig + '?cluster=devnet');

  // ───── 2. submit_bid ───────────────────────────────────────────────────
  const bidPda = deriveBidPda(jobPda, provider1.publicKey);

  console.log('\n[2] submit_bid');
  console.log('   bid pda    :', bidPda.toBase58());
  console.log('   amount     : 750000 lamports');

  const submitBidSig = await program.methods
    .submitBid({
      amountLamports: new BN(750_000),
      confidence: 8500, // 85%
    })
    .accounts({
      provider: provider1.publicKey,
      job: jobPda,
      bid: bidPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([provider1])
    .rpc();
  console.log('   tx         :', submitBidSig);
  console.log('   explorer   : https://explorer.solana.com/tx/' + submitBidSig + '?cluster=devnet');

  console.log('\n========================================');
  console.log('  ON-CHAIN TEST: PASS');
  console.log('========================================');
  console.log('  job  :', jobPda.toBase58());
  console.log('  bid  :', bidPda.toBase58());
  console.log('  next : verify delegated state via ephemeral RPC (next milestone)');
}

main().catch((err) => {
  console.error('\n========================================');
  console.error('  ON-CHAIN TEST: FAIL');
  console.error('========================================');
  console.error('  error :', err?.message ?? err);
  if (err?.logs) {
    console.error('\nprogram logs:');
    for (const line of err.logs) console.error('  ' + line);
  }
  if (err?.stack) console.error('\n', err.stack);
  process.exit(1);
});
