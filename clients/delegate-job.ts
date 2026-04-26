// M2 step 2 — round-trip test for `delegate_job` against the deployed program.
//
// Reuses the Job PDA from the prior `post-job` run if it's still owned by
// sealedbid (i.e. not yet delegated). Otherwise creates a fresh Job via
// post_job, then delegates it.
//
// Run with: npm run delegate-job

import anchorPkg from '@coral-xyz/anchor';
const { AnchorProvider, BN, Program, Wallet } = anchorPkg;
type AnchorIdl = Parameters<typeof Program['constructor']>[0];
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROGRAM_ID = new PublicKey('5JaacAzrnjCwsigZxxHBDkiNuT2SQFG8xxMKVgyy629Q');
const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const RPC_URL = 'https://api.devnet.solana.com';

const JOB_SEED = Buffer.from('job');
const DELEGATE_BUFFER_TAG = Buffer.from('buffer');
const DELEGATION_RECORD_TAG = Buffer.from('delegation');
const DELEGATION_METADATA_TAG = Buffer.from('delegation-metadata');

// Job PDA from the prior `npm run post-job` run (M2 step 1).
const PRIOR_JOB_PDA = new PublicKey('DTvEdufdjorWjgNNJ7PCkpYfGhHZReiZZY22xNf7FGJp');

async function main() {
  const idJsonPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
  const requester = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(idJsonPath, 'utf-8'))),
  );
  console.log('Requester:    ', requester.publicKey.toBase58());

  const connection = new Connection(RPC_URL, 'confirmed');
  const wallet = new Wallet(requester);
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  anchorPkg.setProvider(provider);

  // IDL bundled at idl/sealedbid.json (entry aa) — works on hosts without
  // the anchor CLI installed.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const idlPath = path.resolve(here, '..', 'idl', 'sealedbid.json');
  const idl = JSON.parse(readFileSync(idlPath, 'utf-8'));
  idl.address = PROGRAM_ID.toBase58();
  const program = new Program(idl, provider);

  // Decide which Job to delegate: reuse prior if still owned by sealedbid,
  // else mint a fresh one via post_job.
  let jobPda: PublicKey;
  let jobNonceBytes: Buffer;

  const priorRaw = await connection.getAccountInfo(PRIOR_JOB_PDA, 'confirmed');
  if (priorRaw && priorRaw.owner.equals(PROGRAM_ID)) {
    // Reusable. Decode to retrieve the nonce we need for the seed.
    const decoded = (await program.account.job.fetch(PRIOR_JOB_PDA)) as unknown as {
      jobNonce: any; // BN
    };
    jobPda = PRIOR_JOB_PDA;
    jobNonceBytes = (decoded.jobNonce as BN).toArrayLike(Buffer, 'le', 8);
    console.log('Reusing Job   :', jobPda.toBase58(), '(nonce', decoded.jobNonce.toString() + ')');
  } else {
    // Need a fresh Job. Same defaults as M2 step 1.
    const reason = !priorRaw
      ? 'prior PDA does not exist'
      : 'prior PDA is owned by ' + priorRaw.owner.toBase58() + ' (not sealedbid)';
    console.log('Minting fresh Job — ' + reason);

    const taskType = 0;
    const maxBid = new BN(1_000_000);
    const deadline = new BN(Math.floor(Date.now() / 1000) + 60);
    const nonceBn = new BN(Date.now());
    jobNonceBytes = nonceBn.toArrayLike(Buffer, 'le', 8);
    const jobNonceArr = Array.from(jobNonceBytes);

    const [freshJobPda] = PublicKey.findProgramAddressSync(
      [JOB_SEED, requester.publicKey.toBuffer(), jobNonceBytes],
      PROGRAM_ID,
    );
    jobPda = freshJobPda;
    console.log('Fresh Job PDA :', jobPda.toBase58(), '(nonce', nonceBn.toString() + ')');

    const postSig = await program.methods
      .postJob({ taskType, maxBid, deadline, jobNonce: jobNonceArr })
      .accounts({
        requester: requester.publicKey,
        job: jobPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([requester])
      .rpc();
    console.log('post_job sig  :', postSig);
  }

  // Derive the auxiliary PDAs the #[delegate] macro requires.
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

  console.log('Sending delegate_job...');
  const sig = await program.methods
    .delegateJob({ jobNonce: Array.from(jobNonceBytes) })
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

  console.log('Tx signature  :', sig);
  console.log('Tx explorer   : https://explorer.solana.com/tx/' + sig + '?cluster=devnet');
  console.log('Job explorer  : https://explorer.solana.com/address/' + jobPda.toBase58() + '?cluster=devnet');

  // Confirm new owner.
  const after = await connection.getAccountInfo(jobPda, 'confirmed');
  if (!after) {
    throw new Error('Job PDA disappeared post-delegation.');
  }
  const ownerStr = after.owner.toBase58();
  const annotation = after.owner.equals(DELEGATION_PROGRAM)
    ? '(✓ delegation_program — Job is now in PER)'
    : after.owner.equals(PROGRAM_ID)
    ? '(sealedbid — delegation NOT applied, unexpected)'
    : '(unexpected)';
  console.log('New Job owner :', ownerStr, annotation);
  console.log('Job data len  :', after.data.length, 'bytes');
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
