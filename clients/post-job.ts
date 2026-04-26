// M2 step 1 — round-trip test for `post_job` against the deployed program on devnet.
//
// Loads the deployer keypair as the requester, fetches the IDL from the on-chain
// metadata account (NOT from target/idl/), constructs a PostJobArgs, derives the
// Job PDA, sends the transaction, and prints the decoded Job state.
//
// Run with: npm run post-job

import anchorPkg from '@coral-xyz/anchor';
const { AnchorProvider, BN, Program, Wallet } = anchorPkg;
type AnchorIdl = typeof anchorPkg extends { Idl: infer T } ? T : any;
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// On-chain addresses confirmed at deploy time (PER-INTEGRATION-LOG.md entry k).
const PROGRAM_ID = new PublicKey('5JaacAzrnjCwsigZxxHBDkiNuT2SQFG8xxMKVgyy629Q');
const RPC_URL = 'https://api.devnet.solana.com';

// Seeds match programs/sealedbid/src/lib.rs.
const JOB_SEED = Buffer.from('job');

async function main() {
  // 1. Load deployer keypair as the requester wallet.
  const idJsonPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
  const requester = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(idJsonPath, 'utf-8'))),
  );
  console.log('Requester:    ', requester.publicKey.toBase58());

  // 2. Connect to devnet.
  const connection = new Connection(RPC_URL, 'confirmed');
  const wallet = new Wallet(requester);
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  anchorPkg.setProvider(provider);

  // 3. Fetch IDL from the on-chain metadata account. Force the on-chain path so we
  //    verify it works end-to-end (not target/idl/sealedbid.json).
  //
  //    NOTE: anchor-cli 1.0.1 publishes IDL via the new "Program Metadata Program"
  //    (ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S). @coral-xyz/anchor 0.32.1 still
  //    only knows the old PDA-based scheme and returns null. We shell out to the
  //    Rust CLI (`anchor idl fetch`) which DOES read the new format. The IDL still
  //    comes from the chain — we are just using a different transport.
  const idlJson = execFileSync(
    'anchor',
    ['idl', 'fetch', PROGRAM_ID.toBase58(), '--provider.cluster', 'devnet'],
    { encoding: 'utf-8' },
  );
  const idl = JSON.parse(idlJson) as AnchorIdl;
  // Defensive override: in case the on-chain IDL was uploaded before the program
  // keypair was reconciled, force the canonical program ID. Harmless if already correct.
  (idl as any).address = PROGRAM_ID.toBase58();
  console.log('IDL fetched   :  on-chain via `anchor idl fetch` (address=' + (idl as any).address + ')');

  const program = new Program(idl as AnchorIdl, provider);

  // 4. Build PostJobArgs. Defaults chosen for a minimal round-trip:
  //    - task_type  = 0   (image-caption — first variant in our task enum, see SPEC.md)
  //    - max_bid    = 1_000_000 lamports (~$0.16 — matches MAX_BID_LAMPORTS in .env)
  //    - deadline   = now + 60s (auction window; long enough for the round-trip)
  //    - job_nonce  = Date.now() encoded little-endian as [u8; 8] (unique per call)
  const taskType = 0;
  const maxBid = new BN(1_000_000);
  const deadline = new BN(Math.floor(Date.now() / 1000) + 60);
  const nonceBn = new BN(Date.now());
  const jobNonceBuf = nonceBn.toArrayLike(Buffer, 'le', 8);
  const jobNonceArr = Array.from(jobNonceBuf);
  console.log('job_nonce LE  :', jobNonceArr.join(' '), '(=', nonceBn.toString() + ')');

  // 5. Derive Job PDA (matches `seeds = [JOB_SEED, requester, args.job_nonce]` in lib.rs).
  const [jobPda, jobBump] = PublicKey.findProgramAddressSync(
    [JOB_SEED, requester.publicKey.toBuffer(), jobNonceBuf],
    PROGRAM_ID,
  );
  console.log('Job PDA       :', jobPda.toBase58(), `(bump ${jobBump})`);

  // 6. Send post_job. Args field names are camelCase on the TS side (anchor convention).
  //    Delegation moved to a separate `delegate_job` ix in M2 step 2 — this milestone
  //    only proves the init half of the lifecycle.
  console.log('Sending post_job...');
  const sig = await program.methods
    .postJob({
      taskType,
      maxBid,
      deadline,
      jobNonce: jobNonceArr,
    })
    .accounts({
      requester: requester.publicKey,
      job: jobPda,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([requester])
    .rpc();

  console.log('Tx signature  :', sig);
  console.log('Tx explorer   : https://explorer.solana.com/tx/' + sig + '?cluster=devnet');
  console.log('Job explorer  : https://explorer.solana.com/address/' + jobPda.toBase58() + '?cluster=devnet');

  // 7. Fetch + decode the Job account. Owner is sealedbid (no delegation in this ix).
  const raw = await connection.getAccountInfo(jobPda, 'confirmed');
  if (!raw) {
    throw new Error('Job PDA not found post-tx — something went wrong.');
  }
  console.log('Job owner     :', raw.owner.toBase58(),
    raw.owner.equals(PROGRAM_ID) ? '(sealedbid)' : '(unexpected)');

  const decoded = (await program.account.job.fetch(jobPda)) as unknown as {
    requester: PublicKey;
    taskType: number;
    maxBid: BN;
    deadline: BN;
    status: number;
    bidCount: number;
    jobNonce: BN;
  };
  console.log('Decoded Job   :', JSON.stringify({
    requester: decoded.requester.toBase58(),
    task_type: decoded.taskType,
    max_bid: decoded.maxBid.toString(),
    deadline: decoded.deadline.toString(),
    status: decoded.status,
    bid_count: decoded.bidCount,
    job_nonce: decoded.jobNonce.toString(),
  }, null, 2));
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
