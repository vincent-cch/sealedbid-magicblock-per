// SealedBid v2 — Level C step 3b on-chain auction program.
//
// Surface: post_job (init + escrow) + submit_bid (init only) + delegate_job
// + close_auction (winner determined on-chain inside the ER, drains Bid
// lamports back into Job, schedules commit+undelegate of Job back to L1)
// + settle_auction (atomic on-L1 payout to winner + refund + close Job PDA).
//
// Trust story: every value that decides who gets paid is determined and
// enforced on-chain. The off-chain coordinator orchestrates but never picks
// the winner or signs custody of escrowed funds.
//
// Init and delegate live in different instructions because Solana's runtime
// forbids modifying an account's data and changing its owner within the
// same top-level instruction. The delegate_job ix takes the Job PDA as
// AccountInfo (not Account<Job>) so anchor's exit-time serialize doesn't
// fight the ownership change.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use ephemeral_rollups_sdk::anchor::{delegate, ephemeral, ephemeral_accounts};
use ephemeral_rollups_sdk::consts::{MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;

declare_id!("5JaacAzrnjCwsigZxxHBDkiNuT2SQFG8xxMKVgyy629Q");

pub const JOB_SEED: &[u8] = b"job";
pub const BID_SEED: &[u8] = b"bid";

// Devnet TEE validator (knowledge pack §1, confirmed 2026-04-25 by MagicBlock team).
// Pinned explicitly to avoid the SDK auto-selecting the Asia validator
// (knowledge pack §8 gotcha #1).
pub const TEE_VALIDATOR_PUBKEY: Pubkey =
    anchor_lang::pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

#[ephemeral]
#[program]
pub mod sealedbid {
    use super::*;

    /// Post a new job. Initializes the Job PDA on Solana base layer AND
    /// escrows `max_bid_deposit` lamports inside the Job (Level C step 3b).
    /// Delegation to the TEE validator is a separate `delegate_job` ix.
    ///
    /// Escrow design: any lamports the Job holds beyond rent-exempt minimum
    /// are program-controlled. settle_auction (run after the auction closes
    /// and the Job is undelegated back to L1) is the only path that can move
    /// them out: winning_amount → winner, the rest refunded to requester via
    /// Anchor's `close = requester` constraint.
    pub fn post_job(ctx: Context<PostJob>, args: PostJobArgs) -> Result<()> {
        require!(args.max_bid > 0, SealedBidError::InvalidMaxBid);
        require!(
            args.max_bid_deposit >= args.max_bid,
            SealedBidError::EscrowBelowMaxBid,
        );
        let now = Clock::get()?.unix_timestamp;
        require!(args.deadline > now, SealedBidError::DeadlineInPast);

        let job = &mut ctx.accounts.job;
        job.requester = ctx.accounts.requester.key();
        job.task_type = args.task_type;
        job.max_bid = args.max_bid;
        job.deadline = args.deadline;
        job.status = JobStatus::Open as u8;
        job.bid_count = 0;
        job.job_nonce = u64::from_le_bytes(args.job_nonce);
        job.max_bid_deposit = args.max_bid_deposit;

        // Move the escrow into the Job PDA. Plain SystemProgram::transfer
        // works because requester (signer, system-owned) is the source and
        // Job (system-owned at this point — Anchor `init` set rent-exempt
        // ownership but the PDA is still effectively system-controlled until
        // post-init) is the destination. After this CPI the Job holds rent
        // + escrow; the program owns the escrow lamports.
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.requester.to_account_info(),
                    to: ctx.accounts.job.to_account_info(),
                },
            ),
            args.max_bid_deposit,
        )?;

        Ok(())
    }

    /// Provider submits a bid against an open Job. Runs INSIDE the ER (the Job
    /// must already be delegated). Uses the SDK's `#[ephemeral_accounts]`
    /// pattern: the Job sponsors the new Bid PDA's allocation in PER, so no
    /// regular fee payer is needed (per MagicBlock: ER is gasless and `mut` on
    /// a Signer signals "fee payer", which trips an eligibility check we have
    /// no way to satisfy from a plain user wallet).
    pub fn submit_bid(ctx: Context<SubmitBid>, args: SubmitBidArgs) -> Result<()> {
        require!(
            args.amount_lamports <= ctx.accounts.job.max_bid,
            SealedBidError::BidExceedsMax
        );
        let now = Clock::get()?.unix_timestamp;
        require!(now < ctx.accounts.job.deadline, SealedBidError::AuctionClosed);
        require_keys_neq!(
            ctx.accounts.provider.key(),
            ctx.accounts.job.requester,
            SealedBidError::RequesterCannotBid
        );
        require!(
            ctx.accounts.job.status == JobStatus::Open as u8,
            SealedBidError::JobNotOpen
        );

        // Allocate the ephemeral Bid PDA. The macro provided helper takes the
        // size and sponsors creation off the Job's lamports (delegated, in PER).
        ctx.accounts.create_ephemeral_bid((8 + Bid::INIT_SPACE) as u32)?;

        // Manually serialize the Bid struct into the freshly-allocated buffer.
        let bid_data = Bid {
            job: ctx.accounts.job.key(),
            provider: ctx.accounts.provider.key(),
            amount_lamports: args.amount_lamports,
            confidence: args.confidence,
            submitted_at: now,
        };
        let mut data = ctx.accounts.bid.try_borrow_mut_data()?;
        bid_data.try_serialize(&mut &mut data[..])?;

        let job = &mut ctx.accounts.job;
        job.bid_count = job
            .bid_count
            .checked_add(1)
            .ok_or(SealedBidError::Overflow)?;

        Ok(())
    }

    /// Hand a previously-initialized Job PDA to the TEE validator. Must be
    /// signed by the original requester (PDA seeds bind to it). After this
    /// ix lands on devnet, the Job PDA's owner flips to the delegation
    /// program and subsequent reads/writes route through the ephemeral RPC.
    pub fn delegate_job(ctx: Context<DelegateJob>, args: DelegateJobArgs) -> Result<()> {
        let pda_seeds: &[&[u8]] = &[
            JOB_SEED,
            ctx.accounts.requester.key.as_ref(),
            args.job_nonce.as_ref(),
        ];
        ctx.accounts.delegate_job(
            &ctx.accounts.requester,
            pda_seeds,
            DelegateConfig {
                validator: Some(TEE_VALIDATOR_PUBKEY),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Close an auction by inspecting all submitted Bid PDAs, writing the
    /// winner into Job state, draining the ephemeral Bid lamports back into
    /// the Job sponsor pool, and scheduling a commit+undelegate so the Job
    /// returns to L1 with state intact. Runs INSIDE the ER (Job is delegated).
    ///
    /// remaining_accounts MUST be writable Bid PDAs (we mutate them to drain
    /// lamports). The lowest amount wins; ties resolved by first-seen order.
    ///
    /// Idempotent at the winner-selection level: if Job.winner is already
    /// Some, returns AuctionAlreadyClosed. After this ix lands and the magic
    /// program processes the scheduled intent, the Job PDA flips back to
    /// being owned by this program on L1, ready for settle_auction.
    pub fn close_auction<'info>(
        ctx: Context<'_, '_, 'info, 'info, CloseAuction<'info>>,
    ) -> Result<()> {
        let job_info = ctx.accounts.job.clone();
        let job_key = job_info.key();

        // The Job must be owned by this program in PER (delegated PDAs are
        // re-owned by us inside the rollup). If the owner check fails, we're
        // either before delegation or after undelegation — bail.
        require_keys_eq!(
            *job_info.owner,
            crate::id(),
            SealedBidError::InvalidJobAccount,
        );

        // Manually deserialize the Job since the Accounts struct passes it as
        // AccountInfo (so Anchor doesn't run an exit-time serialize that would
        // fight the magic program's mid-tx state staging — same reason
        // delegate_job uses AccountInfo).
        let mut job: Job = {
            let data = job_info.try_borrow_data()?;
            require!(data.len() >= 8, SealedBidError::InvalidJobAccount);
            Job::try_deserialize(&mut &data[..])?
        };
        require_keys_eq!(
            job.requester,
            ctx.accounts.requester.key(),
            SealedBidError::WinnerMismatch,
        );

        require!(job.winner.is_none(), SealedBidError::AuctionAlreadyClosed);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= job.deadline, SealedBidError::DeadlineNotReached);
        require!(
            !ctx.remaining_accounts.is_empty(),
            SealedBidError::NoBids,
        );

        // ── 1. Pick the winner by lowest amount.
        let mut best: Option<(Pubkey, u64)> = None;
        for acc_info in ctx.remaining_accounts.iter() {
            require_keys_eq!(
                *acc_info.owner,
                crate::id(),
                SealedBidError::InvalidBidOwner,
            );
            let bid = Account::<Bid>::try_from(acc_info)?;
            require_keys_eq!(bid.job, job_key, SealedBidError::BidJobMismatch);

            match best {
                None => best = Some((bid.provider, bid.amount_lamports)),
                Some((_, current)) if bid.amount_lamports < current => {
                    best = Some((bid.provider, bid.amount_lamports));
                }
                _ => {}
            }
        }

        let (winner_pk, winning_amount) = best.ok_or(SealedBidError::NoBids)?;
        job.winner = Some(winner_pk);
        job.winning_amount = Some(winning_amount);
        job.status = JobStatus::Closed as u8;

        // Serialize manually back into the Job's data buffer BEFORE the CPI
        // so the magic program sees the final winner state when staging the
        // commit. After the CPI returns, the Job's owner may already be
        // transitioning — we must not touch it again.
        {
            let mut data = job_info.try_borrow_mut_data()?;
            let mut cursor: &mut [u8] = &mut data[..];
            job.try_serialize(&mut cursor)?;
        }

        emit!(AuctionClosed {
            job: job_key,
            winner: winner_pk,
            amount: winning_amount,
        });

        // Schedule commit + undelegate of the Job back to L1. The magic
        // program will pick this up async, push final state to L1, and flip
        // ownership back to this program. settle_auction (on L1) runs after.
        //
        // Note: Bid PDAs only exist in PER (created via #[ephemeral_accounts]).
        // We don't actively close them here — when the PER session ages out
        // their rent stays in the magic vault. Job's L1 lamport balance is
        // unaffected by PER-side sponsor draws because rent flows
        // sponsor → vault during create, not sponsor → ephemeral.
        commit_and_undelegate_accounts(
            &ctx.accounts.requester.to_account_info(),
            vec![&job_info],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
            None,
        )?;

        Ok(())
    }

    /// Atomic on-chain settlement of a closed auction (Level C step 3b).
    /// Runs on L1 AFTER close_auction's commit+undelegate has been processed.
    ///
    /// 1. Validates the winner SystemAccount matches Job.winner.
    /// 2. Transfers winning_amount lamports from the Job PDA → winner.
    /// 3. Closes the Job PDA via Anchor's `close = requester` constraint,
    ///    refunding ALL remaining lamports (rent + sponsor pre-fund residual
    ///    + unused escrow = max_bid_deposit - winning_amount) to the requester.
    ///
    /// Net per auction: requester pays exactly winning_amount + tx fees. No
    /// lamports stranded in the Job PDA. No off-chain trust needed: the
    /// program enforces every lamport move.
    pub fn settle_auction(ctx: Context<SettleAuction>) -> Result<()> {
        let job = &ctx.accounts.job;
        let winner_pk = job.winner.ok_or(SealedBidError::AuctionNotClosed)?;
        let winning_amount = job
            .winning_amount
            .ok_or(SealedBidError::AuctionNotClosed)?;

        require_keys_eq!(
            ctx.accounts.winner.key(),
            winner_pk,
            SealedBidError::WinnerMismatch,
        );

        let job_info = ctx.accounts.job.to_account_info();
        let winner_info = ctx.accounts.winner.to_account_info();

        // Job is program-owned, so we can mutate its lamports directly without
        // a system_program CPI. `close = requester` on the Accounts struct
        // handles refund of the rest at exit time.
        let job_balance = job_info.lamports();
        require!(
            job_balance >= winning_amount,
            SealedBidError::InsufficientEscrow,
        );

        **job_info.lamports.borrow_mut() = job_balance
            .checked_sub(winning_amount)
            .ok_or(SealedBidError::Overflow)?;
        **winner_info.lamports.borrow_mut() = winner_info
            .lamports()
            .checked_add(winning_amount)
            .ok_or(SealedBidError::Overflow)?;

        emit!(Settled {
            job: ctx.accounts.job.key(),
            winner: winner_pk,
            winning_amount,
            requester_refund: job_info
                .lamports()
                .saturating_sub(Rent::get()?.minimum_balance(8 + Job::INIT_SPACE)),
        });

        Ok(())
    }

    /// SOL-refund-only variant of settle_auction. Used in 'live-usdc-tee'
    /// settlement mode where the winner is paid via a separate private USDC
    /// transferSpl bundle (see auction/onchain-coordinator.ts) and the SOL
    /// escrow inside the Job PDA is purely a trustless backstop that should
    /// flow back to the requester.
    ///
    /// Behavior:
    ///   - Validates the auction is closed (Job.winner.is_some()).
    ///   - Does NOT pay any SOL to the winner.
    ///   - Closes the Job PDA via Anchor's `close = requester` constraint,
    ///     which refunds 100% of the Job's lamport balance (rent + escrow)
    ///     to the requester at exit time.
    ///   - Emits Settled with winning_amount = 0 (signals "USDC-mode refund")
    ///     and requester_refund equal to the full pre-close lamport balance
    ///     minus rent-exempt minimum.
    ///
    /// Trust story: the SOL escrow path is fully program-enforced even in
    /// USDC settlement mode. The USDC payout itself is coordinator-driven
    /// (see knowledge pack §15: private SPL transfers route through the TEE
    /// shuttle, not through this program), so the program guarantees the
    /// refund leg here and the TEE guarantees the USDC leg there.
    pub fn settle_auction_refund(ctx: Context<SettleAuctionRefund>) -> Result<()> {
        let job = &ctx.accounts.job;
        require!(job.winner.is_some(), SealedBidError::AuctionNotClosed);

        let job_info = ctx.accounts.job.to_account_info();
        let pre_close_balance = job_info.lamports();
        let rent_min = Rent::get()?.minimum_balance(8 + Job::INIT_SPACE);

        emit!(Settled {
            job: ctx.accounts.job.key(),
            winner: job.winner.unwrap(),
            // winning_amount = 0 signals "no SOL paid out — see USDC schedule
            // tx in the off-chain settled event for the actual payout".
            winning_amount: 0,
            requester_refund: pre_close_balance.saturating_sub(rent_min),
        });

        // close = requester refunds everything (rent + full escrow) at exit.
        Ok(())
    }
}

// ─── Account contexts ──────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(args: PostJobArgs)]
pub struct PostJob<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,

    #[account(
        init,
        payer = requester,
        space = 8 + Job::INIT_SPACE,
        seeds = [JOB_SEED, requester.key().as_ref(), args.job_nonce.as_ref()],
        bump,
    )]
    pub job: Account<'info, Job>,

    pub system_program: Program<'info, System>,
}

#[ephemeral_accounts]
#[derive(Accounts)]
#[instruction(args: SubmitBidArgs)]
pub struct SubmitBid<'info> {
    // No `#[account(mut)]` on the provider — per MagicBlock, marking the
    // signer mutable signals "fee payer" to PER and trips its eligibility
    // check. ER txs are gasless, so the signer doesn't need to pay anything.
    pub provider: Signer<'info>,

    // The Job sponsors the new Bid PDA's allocation in PER. Must be a
    // delegated PDA (i.e. owned by the delegation program at the base layer)
    // so its lamports are accessible inside the ER session.
    #[account(
        mut,
        sponsor,
        seeds = [JOB_SEED, job.requester.as_ref(), &job.job_nonce.to_le_bytes()],
        bump,
    )]
    pub job: Account<'info, Job>,

    /// CHECK: Ephemeral Bid PDA created in PER, sponsored by the Job. The
    /// SDK's `#[ephemeral_accounts]` macro generates a `create_ephemeral_bid`
    /// helper that allocates this account using lamports from `job` (the
    /// `sponsor` field) without going through the system_program's normal
    /// fee-paying flow.
    #[account(
        mut,
        eph,
        seeds = [BID_SEED, job.key().as_ref(), provider.key().as_ref()],
        bump,
    )]
    pub bid: AccountInfo<'info>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(args: DelegateJobArgs)]
pub struct DelegateJob<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,

    /// CHECK: validated by PDA seeds; ownership change is enforced by the
    /// delegation program CPI.
    #[account(
        mut,
        seeds = [JOB_SEED, requester.key().as_ref(), args.job_nonce.as_ref()],
        bump,
        del,
    )]
    pub job: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct CloseAuction<'info> {
    /// The original requester. NO `mut` — ER writes are gasless per knowledge
    /// pack §15. Requester→Job linkage is verified in the handler.
    pub requester: Signer<'info>,

    /// CHECK: Job PDA. Owner is checked in the handler (must equal crate::id()
    /// in PER), data is manually deserialized, and Job.requester is verified
    /// against the signer. We skip Anchor's seeds constraint here because the
    /// nonce lives inside the account data and re-deriving it would require
    /// reading the buffer twice. Taken as AccountInfo (not Account<Job>) so
    /// Anchor's exit-time serialize doesn't fight the magic program's mid-tx
    /// ownership staging triggered by commit_and_undelegate (same pattern as
    /// delegate_job).
    #[account(mut)]
    pub job: AccountInfo<'info>,

    /// CHECK: address-pinned to MAGIC_CONTEXT_ID. The CPI to the magic program
    /// fails if this is wrong.
    #[account(mut, address = MAGIC_CONTEXT_ID)]
    pub magic_context: AccountInfo<'info>,

    /// CHECK: address-pinned to MAGIC_PROGRAM_ID. Address constraint enforces
    /// program identity; the CPI invokes it directly.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: AccountInfo<'info>,
    // Bid PDAs come through ctx.remaining_accounts (read-only in handler).
}

#[derive(Accounts)]
pub struct SettleAuction<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,

    /// Settlement recipient. Must match Job.winner (verified in handler).
    /// `mut` because we transfer lamports in.
    #[account(mut)]
    pub winner: SystemAccount<'info>,

    /// Job PDA must already be back on L1 (i.e. close_auction's
    /// commit+undelegate has been processed by the magic program). Anchor's
    /// `close = requester` refunds residual lamports at exit time.
    #[account(
        mut,
        has_one = requester,
        close = requester,
        constraint = job.winner.is_some() @ SealedBidError::AuctionNotClosed,
    )]
    pub job: Account<'info, Job>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleAuctionRefund<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,

    /// Job PDA must already be back on L1 (close_auction's commit+undelegate
    /// has been processed by the magic program). `close = requester` refunds
    /// 100% of residual lamports — rent + full escrow — to the requester at
    /// exit time. No winner account needed: USDC payout runs out-of-band via
    /// the SDK's transferSpl helper (see auction/onchain-coordinator.ts).
    #[account(
        mut,
        has_one = requester,
        close = requester,
        constraint = job.winner.is_some() @ SealedBidError::AuctionNotClosed,
    )]
    pub job: Account<'info, Job>,

    pub system_program: Program<'info, System>,
}

// ─── Account data ──────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct Job {
    pub requester: Pubkey,
    pub task_type: u8,
    pub max_bid: u64,
    pub deadline: i64,
    pub status: u8,
    pub bid_count: u32,
    pub job_nonce: u64,
    /// Set by close_auction. None until the auction has been closed on-chain.
    pub winner: Option<Pubkey>,
    /// Lowest bid amount across all submitted Bids; matches winner.
    pub winning_amount: Option<u64>,
    /// Escrow size posted at job creation. Must be ≥ max_bid. Records what
    /// the requester originally locked up so settle_auction (and any explorer)
    /// can compute the refund cleanly.
    pub max_bid_deposit: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Bid {
    pub job: Pubkey,
    pub provider: Pubkey,
    pub amount_lamports: u64,
    pub confidence: u16,
    pub submitted_at: i64,
}

// ─── Args ──────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct PostJobArgs {
    pub task_type: u8,
    pub max_bid: u64,
    pub deadline: i64,
    pub job_nonce: [u8; 8],
    /// Lamports to escrow inside the Job PDA at creation. Must be ≥ max_bid.
    /// Pay this once up front; settle_auction returns the unused portion.
    pub max_bid_deposit: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct SubmitBidArgs {
    pub amount_lamports: u64,
    pub confidence: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct DelegateJobArgs {
    pub job_nonce: [u8; 8],
}

// ─── Status enum (u8 in the account) ───────────────────────────────────────

#[repr(u8)]
pub enum JobStatus {
    Open = 0,
    Closing = 1,
    Closed = 2,
}

// ─── Events ────────────────────────────────────────────────────────────────

#[event]
pub struct AuctionClosed {
    pub job: Pubkey,
    pub winner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Settled {
    pub job: Pubkey,
    pub winner: Pubkey,
    pub winning_amount: u64,
    pub requester_refund: u64,
}

// ─── Errors ────────────────────────────────────────────────────────────────

#[error_code]
pub enum SealedBidError {
    #[msg("bid exceeds job max_bid")]
    BidExceedsMax,
    #[msg("auction already closed (deadline passed)")]
    AuctionClosed,
    #[msg("requester cannot bid on own job")]
    RequesterCannotBid,
    #[msg("job is not Open")]
    JobNotOpen,
    #[msg("max_bid must be > 0")]
    InvalidMaxBid,
    #[msg("deadline must be in the future")]
    DeadlineInPast,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("auction has already been closed (winner already set)")]
    AuctionAlreadyClosed,
    #[msg("auction deadline has not been reached")]
    DeadlineNotReached,
    #[msg("close_auction requires at least one bid in remaining_accounts")]
    NoBids,
    #[msg("a bid account is owned by the wrong program")]
    InvalidBidOwner,
    #[msg("a bid account references a different job")]
    BidJobMismatch,
    #[msg("max_bid_deposit must be ≥ max_bid")]
    EscrowBelowMaxBid,
    #[msg("auction has not been closed yet (no winner set)")]
    AuctionNotClosed,
    #[msg("provided winner account does not match Job.winner")]
    WinnerMismatch,
    #[msg("Job PDA balance below winning_amount — escrow under-funded")]
    InsufficientEscrow,
    #[msg("Job PDA failed owner / data validation")]
    InvalidJobAccount,
}
