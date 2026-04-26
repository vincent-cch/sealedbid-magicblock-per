// On-chain auction coordinator — runs full auctions against the deployed
// SealedBid program on Solana devnet + the MagicBlock TEE-protected
// ephemeral rollup. Level C step 3b (trustless SOL escrow + on-chain
// settle_auction) composed with Level C step 1 (private USDC payout via
// TEE PER) on top.
//
// Three settlement modes, all share the same trustless SOL escrow flow:
//   - 'live-sol'      → settle_auction. Pays winning_amount in SOL from the
//                       Job's escrow → winner. Closes Job, refunds rest.
//                       Rock-solid synchronous demo path.
//   - 'live-usdc-tee' → settle_auction_refund (full SOL escrow refunds to
//                       requester, Job closes) + transferSpl(visibility:
//                       'private', validator: TEE) for the USDC payout.
//                       Async-finalized by the TEE validator's Hydra crank.
//                       Institutional pitch path.
//   - 'simulated'     → no settle ix; emits a fake sig. Stress testing only.
//                       Job stays delegated; escrow stranded until manually
//                       reclaimed.
//
// Six events fire per auction, in order:
//   1. job-posted       (post_job tx landed on base devnet; max_bid_deposit
//                        lamports escrowed inside the Job PDA at the same time)
//   2. job-delegated    (delegate_job tx landed; Job is now in PER)
//   3. bid-submitted    (one event per provider; submit_bid inside TEE-PER)
//   4. auction-closed   (close_auction in PER picked the winner from on-chain
//                        Bid PDAs, drained the ephemeral Bids back into Job,
//                        and scheduled commit+undelegate of Job to L1)
//   5. job-undelegated  (Job's L1 ownership flipped back to the program after
//                        the magic program processed close_auction's intent)
//   6. settled          (settle_auction on L1 paid winning_amount → winner,
//                        Anchor's close=requester refunded the rest. Job PDA
//                        is closed; Bid PDAs were closed inside close_auction)
//
// Notes:
//   - Bids run through the TEE-protected ER (https://devnet-tee.magicblock.app),
//     not the generic non-TEE one. We proved both paths in PER-INTEGRATION-LOG
//     entry (r); TEE is canonical.
//   - The IDL is bundled at `idl/sealedbid.json` and imported directly. The
//     program is upgrade-only (program ID never rotates), so a snapshot is
//     stable. We previously shelled out to `anchor idl fetch` because
//     @coral-xyz/anchor 0.32.1 can't decode the on-chain metadata format
//     anchor-cli 1.0.1 publishes (Program.fetchIdl returns null), but the
//     shell-out broke on hosts without the anchor CLI installed (entry aa).
//   - Bid is not in IDL.accounts (it's `AccountInfo` with `eph` on the program
//     side), so we hand-decode the Borsh layout instead of using anchor's
//     typed account fetch.

import 'dotenv/config';
import { EventEmitter } from 'events';
import anchorPkg from '@coral-xyz/anchor';
const { AnchorProvider, BN, Program, Wallet } = anchorPkg;
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import nacl from 'tweetnacl';
import {
  getAuthToken,
  // @ts-ignore — SDK type bundle missing for transferSpl in 0.11.2; runtime export confirmed.
  transferSpl,
} from '@magicblock-labs/ephemeral-rollups-sdk';

// ─── On-chain constants (matches programs/sealedbid/src/lib.rs) ────────────

export const PROGRAM_ID = new PublicKey('5JaacAzrnjCwsigZxxHBDkiNuT2SQFG8xxMKVgyy629Q');
export const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
export const MAGIC_VAULT = new PublicKey('MagicVau1t999999999999999999999999999999999');
export const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
export const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');

// TEE validator that hosts our delegated state. Pinned per knowledge pack §1.
export const TEE_VALIDATOR = new PublicKey('MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo');

// Devnet USDC (Circle). Re-exported for the demo's balance-diff display.
export const USDC_DEVNET_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

const JOB_SEED = Buffer.from('job');
const BID_SEED = Buffer.from('bid');
const DELEGATE_BUFFER_TAG = Buffer.from('buffer');
const DELEGATION_RECORD_TAG = Buffer.from('delegation');
const DELEGATION_METADATA_TAG = Buffer.from('delegation-metadata');

// Default auction window. Long enough for delegate + parallel submit_bid +
// short slack so PER state has settled before we read.
const DEFAULT_WINDOW_MS = 5000;

// Polling cadence + timeout for waiting on the magic program's async
// commit+undelegate to land on L1. The intent is scheduled by close_auction;
// the magic program processes it shortly after. Devnet usually completes
// within ~3-5s; we cap the wait at 60s.
const UNDELEGATE_POLL_MS = 750;
const UNDELEGATE_TIMEOUT_MS = 60_000;

// ─── Task type mapping (string ↔ u8 on-chain enum) ─────────────────────────

export type TaskTypeName = 'image-caption' | 'text-summarize' | 'echo';
const TASK_TYPE_BYTE: Record<TaskTypeName, number> = {
  'image-caption': 0,
  'text-summarize': 1,
  echo: 2,
};

// ─── Public types ──────────────────────────────────────────────────────────

export interface ProviderEntry {
  keypair: Keypair;
  /** Human-readable name (speedy / accurate / budget). */
  name: string;
  /**
   * Optional per-task pricing in lamports. If a task type is missing for a
   * provider, the coordinator still asks them to bid but uses a randomized
   * amount. Matching the v1 ProviderAgent capability profile.
   */
  pricing?: Partial<Record<TaskTypeName, number>>;
}

export interface RunAuctionOpts {
  taskType: TaskTypeName;
  providers: ProviderEntry[];
  maxBidLamports: number;
  /** Auction window in ms. Default 5000ms (5s). */
  windowMs?: number;
  /** Optional human description (used in 'job-posted' event). */
  description?: string;
}

export interface SubmittedBid {
  providerPubkey: PublicKey;
  providerName: string;
  amountLamports: number;
  confidence: number;
  bidPda: PublicKey;
  sig: string;
}

export interface AuctionResult {
  jobId: string;
  jobPda: PublicKey;
  winner: {
    provider: PublicKey;
    providerName: string;
    amountLamports: number;
    bidPda: PublicKey;
  } | null;
  totalBids: number;
  clearingMs: number;
  taskType: TaskTypeName;
  description: string;
  sigs: {
    postJob: string;
    delegateJob: string;
    submitBids: SubmittedBid[];
    /** close_auction tx signature (Level C step 3a). null if no bids. */
    closeAuction: string | null;
  };
}

export type SettlementModeOption = 'live-sol' | 'live-usdc-tee' | 'simulated';
/**
 * Final mode reported in the `settled` event. `live-sol` / `live-usdc-tee` /
 * `simulated` map to the constructor option of the same name; `failed` /
 * `skipped` are runtime states.
 */
export type SettlementMode =
  | 'live-sol'
  | 'live-usdc-tee'
  | 'simulated'
  | 'failed'
  | 'skipped';

export interface SettlementResult {
  jobId: string;
  /** Winner pubkey base58 (echoed for client convenience). */
  winner: string | null;
  /**
   * Lamports paid to the winner. Always 0 in `live-usdc-tee` (the SOL escrow
   * fully refunds to the requester; the USDC schedule does the actual payout
   * — see `usdcAmountMicro` and `usdcScheduleSig`). Equal to the winning bid
   * in `live-sol`. Equal to the winning bid in `simulated` (sentinel only).
   */
  amountLamports: number;
  /**
   * µUSDC scheduled to the winner via TEE-private transferSpl. Only set in
   * `live-usdc-tee` mode. The actual delivery is async — see knowledge pack
   * §15 ("Private SPL transfer is async") and PER-INTEGRATION-LOG entry (u).
   */
  usdcAmountMicro?: number;
  /**
   * Schedule tx sig from the SDK's transferSpl bundle. Only set in
   * `live-usdc-tee` mode. The schedule lands on L1; the validator's Hydra
   * crank delivers the USDC asynchronously inside the TEE.
   */
  usdcScheduleSig?: string;
  /** Lamports refunded to the requester via Anchor's close=requester. */
  requesterRefundLamports: number;
  /** L1 tx signature on success; sentinel sim_… on simulated; '' on failure. */
  sig: string;
  mode: SettlementMode;
  /** Solana Explorer URL for live mode; null otherwise. */
  explorerUrl: string | null;
  /** Error message when mode='failed'. */
  error?: string;
  ts: number;
}

// ─── Coordinator ───────────────────────────────────────────────────────────

export class OnchainAuctionCoordinator extends EventEmitter {
  private idl: any | null = null;
  private baseConn: Connection;
  /**
   * Cache of in-flight or resolved PER auth tokens, keyed by base58 pubkey.
   * Lets parallel auctions reuse one JWT per signer instead of fetching a
   * fresh token per provider per auction. The token's TTL is set by the
   * MagicBlock TEE; if it expires mid-stress, the bid will fail and the
   * caller can fall back to clearing the cache and retrying.
   */
  private authTokenCache = new Map<string, Promise<{ token: string }>>();
  public readonly settlementMode: SettlementModeOption;

  constructor(
    public readonly requester: Keypair,
    public readonly opts: {
      baseRpcUrl: string;
      ephemeralRpcUrl: string;
      /**
       * Settlement mode for the winner payout. All three modes share the
       * trustless SOL escrow flow (post_job → close_auction → undelegate).
       *
       *   'live-sol'      → settle_auction. Pays winning_amount in SOL from
       *                     the Job's escrow → winner. close=requester
       *                     refunds the rest. Synchronous, single L1 ix.
       *   'live-usdc-tee' → settle_auction_refund (SOL escrow fully refunds
       *                     to requester, Job closes) + transferSpl
       *                     (visibility:'private', validator:TEE) bundle on
       *                     a separate L1 tx for the USDC payout.
       *   'simulated'     → no settle_* ix call; fake sig. Job stays in PER
       *                     and escrow stays stranded — stress testing only.
       *
       * Default: 'live-usdc-tee' (matches the institutional pitch demo).
       */
      settlementMode?: SettlementModeOption;
    },
  ) {
    super();
    this.baseConn = new Connection(opts.baseRpcUrl, 'confirmed');
    this.settlementMode = opts.settlementMode ?? 'live-usdc-tee';
  }

  /**
   * Cached PER auth token fetch. Reuses an in-flight or resolved JWT per
   * signer. Critical under parallel stress runs: 50 auctions × 4 signers
   * (3 providers + requester) without caching = 200 TEE quote round trips.
   * With caching it's 4.
   */
  private ensureAuthToken(kp: Keypair): Promise<{ token: string }> {
    const key = kp.publicKey.toBase58();
    let promise = this.authTokenCache.get(key);
    if (!promise) {
      promise = getAuthToken(
        this.opts.ephemeralRpcUrl,
        kp.publicKey,
        async (msg) => nacl.sign.detached(msg, kp.secretKey),
      );
      this.authTokenCache.set(key, promise);
    }
    return promise;
  }

  /** Drop the cached PER tokens — call when JWTs expire mid-run. */
  clearAuthTokenCache(): void {
    this.authTokenCache.clear();
  }

  /**
   * Load the bundled IDL from `idl/sealedbid.json`. No subprocess, no
   * network — works on any host (including VPS without the anchor CLI).
   * Cached on the instance because the IDL is constant for a deployed
   * program.
   */
  async ensureIdl(): Promise<any> {
    if (this.idl) return this.idl;
    // Resolve relative to this module's location so the path works regardless
    // of which working directory the server was launched from (pm2 sets cwd
    // differently than `npm run server`).
    const here = path.dirname(fileURLToPath(import.meta.url));
    const idlPath = path.resolve(here, '..', 'idl', 'sealedbid.json');
    const idl = JSON.parse(readFileSync(idlPath, 'utf-8'));
    idl.address = PROGRAM_ID.toBase58();
    this.idl = idl;
    return idl;
  }

  /** Run one auction end-to-end. */
  async runAuction(opts: RunAuctionOpts): Promise<AuctionResult> {
    const start = Date.now();
    const idl = await this.ensureIdl();
    const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    const taskTypeByte = TASK_TYPE_BYTE[opts.taskType];
    const description = opts.description ?? `${opts.taskType} auction`;

    const baseAnchorProvider = new AnchorProvider(
      this.baseConn,
      new Wallet(this.requester),
      { commitment: 'confirmed' },
    );
    const baseProgram = new Program(idl, baseAnchorProvider);

    // Build args
    const maxBidBn = new BN(opts.maxBidLamports);
    // Escrow exactly max_bid_lamports for now — every auction reserves the
    // worst case and the unused remainder refunds back at settle time.
    const maxBidDepositBn = new BN(opts.maxBidLamports);
    const deadlineSec = new BN(Math.floor((Date.now() + windowMs) / 1000));
    // 8 random bytes for the nonce. Date.now()+random was fine for sequential
    // auctions but two parallel runAuction() calls within the same ms can
    // produce the same nonce → same Job PDA → second post_job fails. 8 random
    // bytes (64 bits) makes collision astronomically unlikely under any
    // realistic concurrency.
    const jobNonceBytes = randomBytes(8);
    const jobNonceArr = Array.from(jobNonceBytes);

    const [jobPda] = PublicKey.findProgramAddressSync(
      [JOB_SEED, this.requester.publicKey.toBuffer(), jobNonceBytes],
      PROGRAM_ID,
    );
    const jobId = jobPda.toBase58();

    // ── 1. post_job (creates Job PDA + escrows max_bid_deposit) ──────────
    const postJobSig = await baseProgram.methods
      .postJob({
        taskType: taskTypeByte,
        maxBid: maxBidBn,
        deadline: deadlineSec,
        jobNonce: jobNonceArr,
        maxBidDeposit: maxBidDepositBn,
      })
      .accounts({
        requester: this.requester.publicKey,
        job: jobPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([this.requester])
      .rpc();
    this.emit('job-posted', {
      jobId,
      jobPda,
      taskType: opts.taskType,
      maxBidLamports: opts.maxBidLamports,
      maxBidDepositLamports: opts.maxBidLamports,
      description,
      sig: postJobSig,
      ts: Date.now(),
    });

    // ── 2. delegate_job ──────────────────────────────────────────────────
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

    const delegateSig = await baseProgram.methods
      .delegateJob({ jobNonce: jobNonceArr })
      .accounts({
        requester: this.requester.publicKey,
        job: jobPda,
        bufferJob,
        delegationRecordJob,
        delegationMetadataJob,
        ownerProgram: PROGRAM_ID,
        delegationProgram: DELEGATION_PROGRAM,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([this.requester])
      .rpc();
    this.emit('job-delegated', { jobId, sig: delegateSig, ts: Date.now() });

    // ── 3. submit_bid for each provider in parallel via TEE-PER ──────────
    const submitTasks = opts.providers.map(async (p): Promise<SubmittedBid | null> => {
      try {
        // Cached JWT per provider — reused across parallel auctions.
        const auth = await this.ensureAuthToken(p.keypair);
        const ephConn = new Connection(
          `${this.opts.ephemeralRpcUrl}?token=${auth.token}`,
          'confirmed',
        );
        const ephAnchorProvider = new AnchorProvider(
          ephConn,
          new Wallet(p.keypair),
          { commitment: 'confirmed' },
        );
        const erProgram = new Program(idl, ephAnchorProvider);

        // Pick bid amount: prefer provider's per-task price, else randomize.
        let amount: number;
        const priced = p.pricing?.[opts.taskType];
        if (priced !== undefined) {
          amount = Math.min(priced, opts.maxBidLamports - 1);
        } else {
          const lo = Math.min(100_000, Math.floor(opts.maxBidLamports * 0.1));
          const hi = Math.max(lo + 1, opts.maxBidLamports - 50_000);
          amount = Math.floor(lo + Math.random() * (hi - lo));
        }
        const confidence = Math.floor(50 + Math.random() * 50);

        const [bidPda] = PublicKey.findProgramAddressSync(
          [BID_SEED, jobPda.toBuffer(), p.keypair.publicKey.toBuffer()],
          PROGRAM_ID,
        );

        const sig = await erProgram.methods
          .submitBid({ amountLamports: new BN(amount), confidence })
          .accounts({
            provider: p.keypair.publicKey,
            job: jobPda,
            bid: bidPda,
            vault: MAGIC_VAULT,
            magicProgram: MAGIC_PROGRAM,
          } as any)
          .signers([p.keypair])
          .rpc();

        const submitted: SubmittedBid = {
          providerPubkey: p.keypair.publicKey,
          providerName: p.name,
          amountLamports: amount,
          confidence,
          bidPda,
          sig,
        };
        this.emit('bid-submitted', { jobId, ...submitted, ts: Date.now() });
        return submitted;
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message ||
              (err as any).logs?.join(' | ') ||
              err.toString()
            : String(err);
        this.emit('bid-rejected', {
          jobId,
          providerName: p.name,
          providerPubkey: p.keypair.publicKey.toBase58(),
          reason: msg,
          rawError: err,
          ts: Date.now(),
        });
        return null;
      }
    });

    const submitResults = await Promise.all(submitTasks);
    const submittedBids = submitResults.filter((b): b is SubmittedBid => b !== null);

    // ── 4. Wait for the auction window to elapse ─────────────────────────
    const waitMs = Math.max(0, deadlineSec.toNumber() * 1000 - Date.now() + 250);
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    // ── 5. close_auction in PER ─────────────────────────────────────────
    //   The program picks the winner ON-CHAIN by inspecting all Bid PDAs,
    //   drains their lamports back into the Job (so they survive commit),
    //   and CPIs commit_and_undelegate to schedule the Job's return to L1.
    let closeAuctionSig: string | null = null;
    let winner: AuctionResult['winner'] = null;

    if (submittedBids.length > 0) {
      // Cached requester JWT for the close_auction in PER.
      const auth = await this.ensureAuthToken(this.requester);
      const ephConn = new Connection(
        `${this.opts.ephemeralRpcUrl}?token=${auth.token}`,
        'confirmed',
      );
      const ephAnchorProvider = new AnchorProvider(
        ephConn,
        new Wallet(this.requester),
        { commitment: 'confirmed' },
      );
      const erProgram = new Program(idl, ephAnchorProvider);

      try {
        // Bid PDAs MUST be writable: close_auction drains their lamports
        // back into Job (sponsor pool) before scheduling the undelegate.
        const remainingAccounts = submittedBids.map((sb) => ({
          pubkey: sb.bidPda,
          isWritable: true,
          isSigner: false,
        }));

        closeAuctionSig = await erProgram.methods
          .closeAuction()
          .accounts({
            requester: this.requester.publicKey,
            job: jobPda,
            magicContext: MAGIC_CONTEXT,
            magicProgram: MAGIC_PROGRAM,
          } as any)
          .remainingAccounts(remainingAccounts)
          .signers([this.requester])
          .rpc();

        // Read the Job back from PER. Anchor's typed fetch handles the new
        // Option<Pubkey> / Option<u64> fields automatically.
        const jobAfter = (await erProgram.account.job.fetch(jobPda)) as unknown as {
          winner: PublicKey | null;
          winningAmount: any | null; // BN | null
        };
        if (jobAfter.winner) {
          const winnerPk = new PublicKey(jobAfter.winner);
          const winningSb = submittedBids.find((sb) =>
            sb.providerPubkey.equals(winnerPk),
          );
          winner = {
            provider: winnerPk,
            providerName: winningSb?.providerName ?? '(unknown)',
            amountLamports: jobAfter.winningAmount
              ? Number(jobAfter.winningAmount.toString())
              : 0,
            bidPda: winningSb?.bidPda ?? PublicKey.default,
          };
        }
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message ||
              (err as any).logs?.join(' | ') ||
              err.toString()
            : String(err);
        this.emit('close-auction-failed', {
          jobId,
          error: msg,
          rawError: err,
          ts: Date.now(),
        });
        // Don't throw — the auction had bids but close failed (likely a
        // transient PER write problem). The next auction should still run.
      }
    }

    const result: AuctionResult = {
      jobId,
      jobPda,
      winner,
      totalBids: submittedBids.length,
      clearingMs: Date.now() - start,
      taskType: opts.taskType,
      description,
      sigs: {
        postJob: postJobSig,
        delegateJob: delegateSig,
        submitBids: submittedBids,
        closeAuction: closeAuctionSig,
      },
    };
    this.emit('auction-closed', result);

    // ── 6. Settlement: program-enforced or simulated ────────────────────
    const settlement = await this.settleWinner(jobPda, jobId, winner);
    this.emit('settled', settlement);

    return result;
  }

  /** Dispatch settlement to the configured mode. Never throws. */
  private async settleWinner(
    jobPda: PublicKey,
    jobId: string,
    winner: AuctionResult['winner'],
  ): Promise<SettlementResult> {
    const ts = Date.now();
    if (!winner) {
      return {
        jobId,
        winner: null,
        amountLamports: 0,
        requesterRefundLamports: 0,
        sig: '',
        mode: 'skipped',
        explorerUrl: null,
        ts,
      };
    }

    if (this.settlementMode === 'simulated') {
      const fake = randomBytes(32).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
      return {
        jobId,
        winner: winner.provider.toBase58(),
        amountLamports: winner.amountLamports,
        requesterRefundLamports: 0,
        sig: `sim_${fake}`,
        mode: 'simulated',
        explorerUrl: null,
        ts,
      };
    }

    if (this.settlementMode === 'live-usdc-tee') {
      return this.settleUsdcTee(jobPda, jobId, winner);
    }

    return this.settleSolOnChain(jobPda, jobId, winner);
  }

  /**
   * Wait for close_auction's commit+undelegate to complete on L1, then call
   * settle_auction. settle_auction transfers winning_amount → winner and
   * Anchor's close=requester refunds the rest of Job's lamports to the
   * requester, closing the Job PDA in the same tx.
   */
  private async settleSolOnChain(
    jobPda: PublicKey,
    jobId: string,
    winner: NonNullable<AuctionResult['winner']>,
  ): Promise<SettlementResult> {
    try {
      const ready = await this.waitAndEmitUndelegated(jobPda, jobId);
      if (!ready.ok) {
        return this.failedSettlement(
          jobId,
          winner,
          new Error(`undelegation timeout (${UNDELEGATE_TIMEOUT_MS}ms)`),
          'live-sol',
        );
      }

      const idl = await this.ensureIdl();
      const provider = new AnchorProvider(
        this.baseConn,
        new Wallet(this.requester),
        { commitment: 'confirmed' },
      );
      const program = new Program(idl, provider);

      const sig = await program.methods
        .settleAuction()
        .accounts({
          requester: this.requester.publicKey,
          winner: winner.provider,
          job: jobPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([this.requester])
        .rpc();
      await this.baseConn.confirmTransaction(sig, 'confirmed');

      const requesterRefundLamports = Math.max(
        0,
        ready.jobBalanceBefore - winner.amountLamports,
      );

      return {
        jobId,
        winner: winner.provider.toBase58(),
        amountLamports: winner.amountLamports,
        requesterRefundLamports,
        sig,
        mode: 'live-sol',
        explorerUrl: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
        ts: Date.now(),
      };
    } catch (err) {
      return this.failedSettlement(jobId, winner, err, 'live-sol');
    }
  }

  /**
   * USDC settlement via the TEE-protected PER. Two L1 ixs, both atomic:
   *
   *   1. settle_auction_refund — closes the Job PDA, refunds 100% of the
   *      lamport balance (rent + escrow) to the requester. The SOL escrow
   *      was a trustless backstop; in USDC mode it just unwinds.
   *   2. transferSpl(visibility:'private', validator:TEE) — schedules a
   *      private USDC transfer from requester ATA → winner ATA via the TEE
   *      shuttle. The bid amount (in `amountLamports`, our universal "bid
   *      units") is treated as µUSDC (6 decimals) — same numeric range,
   *      stablecoin-denominated. Hydra crank delivers async (knowledge pack
   *      §15: "Private SPL transfer is async").
   */
  private async settleUsdcTee(
    jobPda: PublicKey,
    jobId: string,
    winner: NonNullable<AuctionResult['winner']>,
  ): Promise<SettlementResult> {
    try {
      const ready = await this.waitAndEmitUndelegated(jobPda, jobId);
      if (!ready.ok) {
        return this.failedSettlement(
          jobId,
          winner,
          new Error(`undelegation timeout (${UNDELEGATE_TIMEOUT_MS}ms)`),
          'live-usdc-tee',
        );
      }

      const idl = await this.ensureIdl();
      const provider = new AnchorProvider(
        this.baseConn,
        new Wallet(this.requester),
        { commitment: 'confirmed' },
      );
      const program = new Program(idl, provider);

      // Step 1 — refund the SOL escrow + close the Job PDA.
      const refundSig = await program.methods
        .settleAuctionRefund()
        .accounts({
          requester: this.requester.publicKey,
          job: jobPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([this.requester])
        .rpc();
      await this.baseConn.confirmTransaction(refundSig, 'confirmed');
      const requesterRefundLamports = ready.jobBalanceBefore;

      // Step 2 — schedule the private USDC transfer via the TEE shuttle.
      // The bid amount (universal "bid units") is treated as µUSDC.
      const amountMicroUsdc = BigInt(winner.amountLamports);
      const shuttleId = Math.floor(Math.random() * 0xffffffff);

      const ixs = await transferSpl(
        this.requester.publicKey,
        winner.provider,
        USDC_DEVNET_MINT,
        amountMicroUsdc,
        {
          visibility: 'private',
          fromBalance: 'base',
          toBalance: 'base',
          validator: TEE_VALIDATOR, // §8 fix: pin TEE explicitly to avoid auto-selection of Asia validator
          payer: this.requester.publicKey,
          initIfMissing: false,
          initAtasIfMissing: false,
          initVaultIfMissing: false,
          shuttleId,
        },
      );

      const tx = new Transaction().add(...(ixs as Transaction['instructions']));
      const { blockhash } = await this.baseConn.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = this.requester.publicKey;
      tx.sign(this.requester);
      const usdcSig = await this.baseConn.sendRawTransaction(tx.serialize());
      await this.baseConn.confirmTransaction(usdcSig, 'confirmed');

      return {
        jobId,
        winner: winner.provider.toBase58(),
        amountLamports: 0, // SOL paid to winner = 0 in USDC mode
        usdcAmountMicro: Number(amountMicroUsdc),
        usdcScheduleSig: usdcSig,
        requesterRefundLamports,
        sig: refundSig,
        mode: 'live-usdc-tee',
        // Surface the refund tx in the explorer link; the USDC schedule sig
        // lives on `usdcScheduleSig` for clients that want to render both.
        explorerUrl: `https://explorer.solana.com/tx/${refundSig}?cluster=devnet`,
        ts: Date.now(),
      };
    } catch (err) {
      return this.failedSettlement(jobId, winner, err, 'live-usdc-tee');
    }
  }

  /** Common pre-settlement: wait for undelegation, snapshot Job balance. */
  private async waitAndEmitUndelegated(
    jobPda: PublicKey,
    jobId: string,
  ): Promise<{ ok: boolean; jobBalanceBefore: number }> {
    const ok = await this.waitForUndelegation(jobPda);
    if (!ok) return { ok: false, jobBalanceBefore: 0 };
    this.emit('job-undelegated', { jobId, ts: Date.now() });
    const info = await this.baseConn.getAccountInfo(jobPda);
    return { ok: true, jobBalanceBefore: info?.lamports ?? 0 };
  }

  private failedSettlement(
    jobId: string,
    winner: NonNullable<AuctionResult['winner']>,
    err: unknown,
    settleMode: 'live-sol' | 'live-usdc-tee' | 'unknown' = 'unknown',
  ): SettlementResult {
    const msg = err instanceof Error ? err.message : String(err);

    // LOUD failure logging. Every settle catch funnels through here, so this
    // is the single place we surface the actual reason a settle ix blew up.
    // Without this, the UI shows SETTLEMENT FAILED but stdout is silent and
    // there's nothing to grep in the pm2 logs.
    console.error(
      `[server] settle failed for auction ${jobId} (mode=${settleMode}, winner=${winner.provider.toBase58()}, amount=${winner.amountLamports}):`,
      msg,
    );

    // Anchor's AnchorError and web3.js's SendTransactionError both attach
    // .logs (string[]) on the synchronous error object when the failure
    // came from simulation. Surface those — they usually contain the
    // program-side `panicked at` or anchor error code that explains why.
    const anchorLogs = (err as any)?.logs;
    if (Array.isArray(anchorLogs) && anchorLogs.length > 0) {
      console.error('[server] anchor logs:\n  ' + anchorLogs.join('\n  '));
    }

    return {
      jobId,
      winner: winner.provider.toBase58(),
      amountLamports: winner.amountLamports,
      requesterRefundLamports: 0,
      sig: '',
      mode: 'failed',
      explorerUrl: null,
      error: msg,
      ts: Date.now(),
    };
  }

  /**
   * Poll the Job PDA until its L1 owner flips back to PROGRAM_ID. Returns
   * true on flip, false on timeout. Cheap RPC reads at UNDELEGATE_POLL_MS
   * cadence (default 750ms).
   */
  private async waitForUndelegation(jobPda: PublicKey): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < UNDELEGATE_TIMEOUT_MS) {
      const info = await this.baseConn.getAccountInfo(jobPda, 'confirmed');
      if (info && info.owner.equals(PROGRAM_ID)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, UNDELEGATE_POLL_MS));
    }
    return false;
  }
}
