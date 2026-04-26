// M2 step 3 (non-TEE variant) — round-trip test for `submit_bid` against a
// Job delegated to the generic MagicBlock ephemeral rollup endpoint.
//
// Mirrors `submit-bid.ts` except the ephemeral RPC is the public, non-TEE
// `https://devnet.magicblock.app` (no JWT auth, no TDX attestation, no
// privacy guarantees). Useful as a baseline for the bid round-trip while we
// wait on the MagicBlock team's answer about TEE fee-payer registration.
//
// Run with: npm run submit-bid-nontee

import 'dotenv/config';
import anchorPkg from '@coral-xyz/anchor';
const { AnchorProvider, BN, Program, Wallet } = anchorPkg;
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTopUpEscrowInstruction,
  escrowPdaFromEscrowAuthority,
} from '@magicblock-labs/ephemeral-rollups-sdk';

const PROGRAM_ID = new PublicKey('5JaacAzrnjCwsigZxxHBDkiNuT2SQFG8xxMKVgyy629Q');
const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const BASE_RPC_URL = 'https://api.devnet.solana.com';
// Non-TEE generic ER endpoint — no JWT required.
const EPHEMERAL_RPC_URL = 'https://devnet.magicblock.app';

const JOB_SEED = Buffer.from('job');
const BID_SEED = Buffer.from('bid');
const DELEGATE_BUFFER_TAG = Buffer.from('buffer');
const DELEGATION_RECORD_TAG = Buffer.from('delegation');
const DELEGATION_METADATA_TAG = Buffer.from('delegation-metadata');

async function main() {
  // ── 0. Load both signers ──────────────────────────────────────────────
  const idJsonPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
  const requester = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(idJsonPath, 'utf-8'))),
  );

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const providerPath = path.join(projectRoot, 'wallets', 'provider-1.json');
  const provider = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(providerPath, 'utf-8'))),
  );

  console.log('Requester    :', requester.publicKey.toBase58());
  console.log('Provider     :', provider.publicKey.toBase58());
  console.log('ER endpoint  :', EPHEMERAL_RPC_URL, '(non-TEE)');

  // ── 1. Fetch IDL once (same program either RPC) ───────────────────────
  const idlJson = execFileSync(
    'anchor',
    ['idl', 'fetch', PROGRAM_ID.toBase58(), '--provider.cluster', 'devnet'],
    { encoding: 'utf-8' },
  );
  const idl = JSON.parse(idlJson);
  idl.address = PROGRAM_ID.toBase58();

  // ── 2. Bootstrap a fresh Job on base devnet ───────────────────────────
  const baseConn = new Connection(BASE_RPC_URL, 'confirmed');
  const baseProvider = new AnchorProvider(baseConn, new Wallet(requester), {
    commitment: 'confirmed',
  });
  const baseProgram = new Program(idl, baseProvider);

  const taskType = 0;
  const maxBid = new BN(1_000_000);
  const deadline = new BN(Math.floor(Date.now() / 1000) + 600);
  const nonceBn = new BN(Date.now());
  const jobNonceBytes = nonceBn.toArrayLike(Buffer, 'le', 8);
  const jobNonceArr = Array.from(jobNonceBytes);

  const [jobPda] = PublicKey.findProgramAddressSync(
    [JOB_SEED, requester.publicKey.toBuffer(), jobNonceBytes],
    PROGRAM_ID,
  );
  console.log('Job PDA      :', jobPda.toBase58(), '(nonce', nonceBn.toString() + ')');

  console.log('post_job…');
  const postSig = await baseProgram.methods
    .postJob({ taskType, maxBid, deadline, jobNonce: jobNonceArr })
    .accounts({
      requester: requester.publicKey,
      job: jobPda,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([requester])
    .rpc();
  console.log('  sig        :', postSig);

  // ── 2.5. Pre-fund the Job PDA so it can sponsor bid allocations in PER.
  const sponsorTopUp = 10_000_000;
  console.log('topping up Job sponsor:', sponsorTopUp, 'lamports');
  const sponsorTx = new Transaction().add(
    anchorPkg.web3.SystemProgram.transfer({
      fromPubkey: requester.publicKey,
      toPubkey: jobPda,
      lamports: sponsorTopUp,
    }),
  );
  const sponsorSig = await baseConn.sendTransaction(sponsorTx, [requester]);
  await baseConn.confirmTransaction(sponsorSig, 'confirmed');
  console.log('  sig        :', sponsorSig);

  // ── 3. Delegate the fresh Job ─────────────────────────────────────────
  const [bufferJob] = PublicKey.findProgramAddressSync(
    [DELEGATE_BUFFER_TAG, jobPda.toBuffer()],
    PROGRAM_ID,
  );
  const [delegationRecordJob] = PublicKey.findProgramAddressSync(
    [DELEGATION_RECORD_TAG, jobPda.toBuffer()],
    DELEGATION_PROGRAM,
  );
  const [delegationMetadataJob] = PublicKey.findProgramAddressSync(
    [DELEGATION_METADATA_TAG, jobPda.toBuffer()],
    DELEGATION_PROGRAM,
  );

  console.log('delegate_job…');
  const delSig = await baseProgram.methods
    .delegateJob({ jobNonce: jobNonceArr })
    .accounts({
      requester: requester.publicKey,
      job: jobPda,
      bufferJob,
      delegationRecordJob,
      delegationMetadataJob,
      ownerProgram: PROGRAM_ID,
      delegationProgram: DELEGATION_PROGRAM,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([requester])
    .rpc();
  console.log('  sig        :', delSig);

  const afterDel = await baseConn.getAccountInfo(jobPda, 'confirmed');
  if (!afterDel || !afterDel.owner.equals(DELEGATION_PROGRAM)) {
    throw new Error(
      `Delegation didn't take. Job owner is ${afterDel?.owner.toBase58() ?? 'null'}.`,
    );
  }
  console.log('  base-owner :', afterDel.owner.toBase58(), '(✓ delegation_program)');

  // (Escrow top-up removed: with the new #[ephemeral_accounts] sponsor pattern
  // on the program side, the Job's lamports cover the new Bid PDA's allocation
  // inside PER. ER txs are gasless from the provider's perspective.)

  // ── 4. Open ephemeral RPC, no JWT auth ────────────────────────────────
  const ephemeralConn = new Connection(EPHEMERAL_RPC_URL, 'confirmed');
  console.log('PER slot     :', await ephemeralConn.getSlot('confirmed'));

  const ephemeralProvider = new AnchorProvider(ephemeralConn, new Wallet(provider), {
    commitment: 'confirmed',
  });
  const erProgram = new Program(idl, ephemeralProvider);

  // ── 5. Read the live Job state from PER ───────────────────────────────
  const jobView = (await erProgram.account.job.fetch(jobPda)) as unknown as {
    requester: PublicKey;
    taskType: number;
    maxBid: any;
    deadline: any;
    status: number;
    bidCount: number;
    jobNonce: any;
  };
  console.log('Job (in PER) : status=' + jobView.status, '· max_bid=' + jobView.maxBid.toString(),
    '· deadline=' + jobView.deadline.toString(), '· bid_count=' + jobView.bidCount);

  // ── 6. Build SubmitBidArgs and derive Bid PDA ─────────────────────────
  const amount = new BN(750_000);
  const confidence = 80;

  const [bidPda, bidBump] = PublicKey.findProgramAddressSync(
    [BID_SEED, jobPda.toBuffer(), provider.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  console.log('Bid PDA      :', bidPda.toBase58(), '(bump', bidBump + ')');

  // ── 7. submit_bid via non-TEE ER ──────────────────────────────────────
  // The #[ephemeral_accounts] macro requires vault + magic_program in the
  // accounts list (auto-injected by the macro on the program side; the IDL
  // pins their addresses to canonical SDK constants).
  console.log('submit_bid via non-TEE ER…');
  const sig = await erProgram.methods
    .submitBid({ amountLamports: amount, confidence })
    .accounts({
      provider: provider.publicKey,
      job: jobPda,
      bid: bidPda,
      vault: new PublicKey('MagicVau1t999999999999999999999999999999999'),
      magicProgram: new PublicKey('Magic11111111111111111111111111111111111111'),
    } as any)
    .signers([provider])
    .rpc();

  console.log('Tx signature :', sig);

  // ── 8. Decode the new Bid ─────────────────────────────────────────────
  // Bid is stripped from the IDL (raw AccountInfo with `eph`). Hand-decode.
  const rawBid = await ephemeralConn.getAccountInfo(bidPda, 'confirmed');
  if (!rawBid) throw new Error('Bid PDA not found in PER post-tx.');
  const buf = Buffer.from(rawBid.data);
  let off = 8;
  const decodedJob = new PublicKey(buf.subarray(off, off + 32)); off += 32;
  const decodedProvider = new PublicKey(buf.subarray(off, off + 32)); off += 32;
  const amountLamports = buf.readBigUInt64LE(off); off += 8;
  const decodedConfidence = buf.readUInt16LE(off); off += 2;
  const submittedAt = buf.readBigInt64LE(off); off += 8;
  console.log('Decoded Bid  :', JSON.stringify({
    job: decodedJob.toBase58(),
    provider: decodedProvider.toBase58(),
    amount_lamports: amountLamports.toString(),
    confidence: decodedConfidence,
    submitted_at: submittedAt.toString(),
  }, null, 2));

  const jobAfter = (await erProgram.account.job.fetch(jobPda)) as unknown as {
    bidCount: number;
  };
  console.log('Job bid_count after submit_bid:', jobAfter.bidCount, '(was 0)');
}

main().catch((e) => {
  console.error('FAIL:', e);
  if (e?.transactionLogs) {
    console.error('Logs:');
    for (const log of e.transactionLogs) console.error(' ', log);
  }
  process.exit(1);
});
