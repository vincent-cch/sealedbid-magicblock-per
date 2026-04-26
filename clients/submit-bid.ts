// M2 step 3 — round-trip test for `submit_bid` against a Job that lives in
// the MagicBlock Private Ephemeral Rollup.
//
// Self-bootstrapping: mints a fresh Job via post_job on base devnet, hands
// it to the delegation program via delegate_job (also base devnet), then
// flips to the TEE-protected ephemeral RPC and submits the bid as a
// different signer (provider-1, which is NOT the requester per our
// RequesterCannotBid rule).
//
// Run with: npm run submit-bid

import 'dotenv/config';
import anchorPkg from '@coral-xyz/anchor';
const { AnchorProvider, BN, Program, Wallet } = anchorPkg;
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import {
  getAuthToken,
  createTopUpEscrowInstruction,
  escrowPdaFromEscrowAuthority,
} from '@magicblock-labs/ephemeral-rollups-sdk';

const PROGRAM_ID = new PublicKey('5JaacAzrnjCwsigZxxHBDkiNuT2SQFG8xxMKVgyy629Q');
const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const BASE_RPC_URL = 'https://api.devnet.solana.com';
const EPHEMERAL_RPC_URL =
  process.env.MAGICBLOCK_EPHEMERAL_RPC_URL ?? 'https://devnet-tee.magicblock.app';

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

  // ── 1. Fetch IDL once (it's the same program either RPC we use) ───────
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
  // 10-minute auction window so we have time to delegate + bid + decode.
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

  // ── 2.5. Pre-fund the Job PDA with extra lamports so it can sponsor bid
  //         allocations inside PER. post_job leaves the Job at the rent-exempt
  //         minimum; without spare lamports, `create_ephemeral_bid` fails with
  //         "insufficient funds for rent" because the macro siphons rent from
  //         the sponsor (the Job) when allocating the new Bid PDA.
  const sponsorTopUp = 10_000_000; // 0.01 SOL — enough for ~10 bids
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

  // ── 3. Delegate the fresh Job to the TEE validator ────────────────────
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

  // Sanity: confirm the Job's base-layer owner is now the delegation program.
  const afterDel = await baseConn.getAccountInfo(jobPda, 'confirmed');
  if (!afterDel || !afterDel.owner.equals(DELEGATION_PROGRAM)) {
    throw new Error(
      `Delegation didn't take. Job owner is ${afterDel?.owner.toBase58() ?? 'null'}; expected ${DELEGATION_PROGRAM.toBase58()}.`,
    );
  }
  console.log('  base-owner :', afterDel.owner.toBase58(), '(✓ delegation_program)');

  // (Escrow top-up removed: with the new #[ephemeral_accounts] sponsor pattern
  // on the program side, the Job's lamports cover the new Bid PDA's allocation
  // inside PER. ER txs are gasless from the provider's perspective.)

  // ── 4. Open ephemeral RPC as the provider, get JWT ────────────────────
  console.log('Auth         : requesting JWT from', EPHEMERAL_RPC_URL);
  const auth = await getAuthToken(
    EPHEMERAL_RPC_URL,
    provider.publicKey,
    async (msg) => nacl.sign.detached(msg, provider.secretKey),
  );
  console.log('Token        :', auth.token.slice(0, 16) + '… (expires ' + new Date(auth.expiresAt).toISOString() + ')');

  const ephemeralConn = new Connection(`${EPHEMERAL_RPC_URL}?token=${auth.token}`, 'confirmed');
  console.log('PER slot     :', await ephemeralConn.getSlot('confirmed'));

  const ephemeralProvider = new AnchorProvider(ephemeralConn, new Wallet(provider), {
    commitment: 'confirmed',
  });
  const erProgram = new Program(idl, ephemeralProvider);

  // ── 5. Read the live Job state from PER, sanity check the auction ─────
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
  // M2 step 3 placeholder: no sealed envelope field on SubmitBidArgs yet
  // (current struct = { amount_lamports: u64, confidence: u16 }). The 64-byte
  // ciphertext recipient = TEE_VALIDATOR_PUBKEY pattern lands in Level B step 2.
  const amount = new BN(750_000); // < max_bid 1_000_000
  const confidence = 80;          // 0–100 conviction score

  const [bidPda, bidBump] = PublicKey.findProgramAddressSync(
    [BID_SEED, jobPda.toBuffer(), provider.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  console.log('Bid PDA      :', bidPda.toBase58(), '(bump', bidBump + ')');

  // ── 7. submit_bid via the ephemeral RPC ───────────────────────────────
  // The #[ephemeral_accounts] macro requires vault + magic_program in the
  // accounts list (auto-injected by the macro on the program side; the IDL
  // pins their addresses to canonical SDK constants).
  console.log('submit_bid via PER…');
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

  // ── 8. Decode the new Bid, also via PER ───────────────────────────────
  // Bid is stripped from the IDL (not referenced as Account<T> anywhere in
  // the program — it's a raw AccountInfo with `eph`), so anchor's coder has
  // no entry for it. Hand-decode the Borsh layout. Layout matches the Rust
  // struct: 8-byte anchor discriminator + struct fields in declaration order.
  const rawBid = await ephemeralConn.getAccountInfo(bidPda, 'confirmed');
  if (!rawBid) throw new Error('Bid PDA not found in PER post-tx.');
  const buf = Buffer.from(rawBid.data);
  let off = 8; // skip discriminator
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

  // Re-read Job to confirm bid_count incremented.
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
