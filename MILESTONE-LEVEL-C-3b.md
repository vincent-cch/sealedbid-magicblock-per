# SealedBid v2 — Level C step 3b: program-enforced escrow + on-chain settlement + atomic Job reclaim

**Date:** 2026-04-26
**Status:** ✅ Shipped. The auction is now end-to-end trustless: the program controls every lamport from escrow at `post_job` through payout at `settle_auction`. Per-auction rent leak is eliminated.

> Picks up where [`MILESTONE-LEVEL-C-3a.md`](./MILESTONE-LEVEL-C-3a.md) left off. Step 3a made the WINNER trustless. Step 3b makes the PAYOUT trustless and reclaims the Job PDA.

---

## What changed (one paragraph)

`post_job` now escrows `max_bid_deposit` lamports into the Job PDA. `close_auction` (in PER) picks the winner and CPIs `commit_and_undelegate` so the Job returns to L1 with state intact. A new `settle_auction` ix on L1 reads `Job.winner` + `Job.winning_amount`, transfers exactly the winning amount from Job's escrow to the winner, and closes the Job PDA — refunding all residual lamports (rent + unused escrow) to the requester in the same atomic tx. The off-chain coordinator orchestrates but never signs custody decisions; it can't pay the wrong winner, can't pay the wrong amount, and can't strand any funds.

---

## What this fixes

| Problem (before, entry s/v) | Fix (after, entry w) |
|---|---|
| Off-chain coordinator did `SystemProgram.transfer(requester → winner)` and could lie about who/how much | Program reads on-chain `Job.winner` + `Job.winning_amount`, transfers from program-controlled escrow. Coordinator signs nothing the program didn't approve. |
| ~2.5M lamports per auction stranded in retired (delegated) Job PDA permanently | Job PDA is closed at settle time; rent + unused escrow refund to requester in the same tx. Net per-auction cost dropped from ~25M lamports → ~513k lamports (50× cheaper). |
| Two-tx settlement: payout, then "someday" reclaim. Reclaim never actually happened. | One atomic L1 ix combines payout + reclaim. Cannot half-finish. |

---

## New surface

```
post_job        (L1)           — creates Job + escrows max_bid_deposit
delegate_job    (L1 → PER)     — unchanged
submit_bid      (PER, gasless) — unchanged
close_auction   (PER)          — picks winner AND CPIs commit_and_undelegate(Job)
[magic prog]    (L1, async)    — flips Job ownership back to our program (~3-5s on devnet)
settle_auction  (L1)           — pays winner from escrow, closes Job PDA, refunds rest
```

`settle_auction` is one atomic L1 ix that combines payout + rent reclaim. Combining keeps the trust story tight and the client simple.

---

## Reference instructions (additions on top of step 3a)

### post_job — now escrows

```rust
pub fn post_job(ctx: Context<PostJob>, args: PostJobArgs) -> Result<()> {
    require!(args.max_bid > 0, SealedBidError::InvalidMaxBid);
    require!(args.max_bid_deposit >= args.max_bid, SealedBidError::EscrowBelowMaxBid);
    // ... init Job state ...

    // Move the escrow into the Job PDA.
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
```

### close_auction — now also undelegates

After picking the winner and serializing Job state, schedule the commit + undelegate so the Job returns to L1:

```rust
commit_and_undelegate_accounts(
    &ctx.accounts.requester.to_account_info(),
    vec![&job_info],                  // Job is AccountInfo, not Account<Job>
    &ctx.accounts.magic_context,
    &ctx.accounts.magic_program,
    None,
)?;
```

**Critical detail:** Job MUST be passed as `AccountInfo<'info>` (not `Account<'info, Job>`). With `Account<T>`, Anchor's exit-time `T::try_serialize` runs AFTER the magic program has staged the ownership flip, and Solana rejects with `instruction modified data of an account it does not own`. Mirror the `delegate_job` pattern: declare as `AccountInfo`, manually `try_deserialize` / `try_serialize` BEFORE the CPI.

### settle_auction — atomic payout + close

```rust
pub fn settle_auction(ctx: Context<SettleAuction>) -> Result<()> {
    let job = &ctx.accounts.job;
    let winner_pk = job.winner.ok_or(SealedBidError::AuctionNotClosed)?;
    let winning_amount = job.winning_amount.ok_or(SealedBidError::AuctionNotClosed)?;

    require_keys_eq!(ctx.accounts.winner.key(), winner_pk, SealedBidError::WinnerMismatch);

    // Direct lamport mutation: Job is program-owned, so no system_program CPI needed.
    let job_info = ctx.accounts.job.to_account_info();
    let winner_info = ctx.accounts.winner.to_account_info();
    let job_balance = job_info.lamports();
    require!(job_balance >= winning_amount, SealedBidError::InsufficientEscrow);

    **job_info.lamports.borrow_mut() = job_balance - winning_amount;
    **winner_info.lamports.borrow_mut() = winner_info.lamports() + winning_amount;

    // close = requester on the Accounts struct refunds the rest at exit time.
    Ok(())
}

#[derive(Accounts)]
pub struct SettleAuction<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(mut)]
    pub winner: SystemAccount<'info>,
    #[account(
        mut, has_one = requester, close = requester,
        constraint = job.winner.is_some() @ SealedBidError::AuctionNotClosed,
    )]
    pub job: Account<'info, Job>,
    pub system_program: Program<'info, System>,
}
```

---

## Demo run — 3 auctions, all settled, all reclaimed

| Auction | Winner | Amount | Refund to requester | settle_auction sig |
|---|---|---|---|---|
| 1 (image-caption) | speedy | 180,000 L | 2,331,680 L | [`2kp6eU97KAxE…`](https://explorer.solana.com/tx/2kp6eU97KAxE9ERxj71pFTncF1QCZZrAHDh6xzrE2uknRrvTmHcUU8QWK8itCM9RcDegar8szEBoiCZPvFL1TUdV?cluster=devnet) |
| 2 (text-summarize) | accurate | 220,000 L | 2,291,680 L | [`woqQhtj91aAs5Q1P…`](https://explorer.solana.com/tx/woqQhtj91aAs5Q1Pi46rYZcBVsuGVFMH1zPJzqMjHWN4hinTtN6FVstuYnUZHt33Fphg9ZCL8QGJ4MHe7qMpmAo?cluster=devnet) |
| 3 (echo) | budget | 150,000 L | 2,361,680 L | [`24fCKUaZYvpHSZk3…`](https://explorer.solana.com/tx/24fCKUaZYvpHSZk36iqZDab4CniKSpwH1RwBGAAHyDCPSbisEau2MyNExC1xELqLJXswGawkrPYfUDaeFBXqSs9E?cluster=devnet) |

Total winning bids paid: 550,000 L. Total requester delta: -1,538,000 L. Per-auction net cost: ~513,000 L (~0.000513 SOL). vs. ~25M L per auction in step 3a (rent stranded forever in retired Job PDAs) → **~50× cheaper.**

---

## What's still on the table

1. **Reclaim ephemeral Bid PDA rent.** Each Bid PDA created via `#[ephemeral_accounts]` deposits ~80k lamports into `EPHEMERAL_VAULT_ID`, never recovered. Adding `EphemeralAccount::close()` for each Bid inside `close_auction` (before the commit+undelegate CPI) would push per-bid lamports back into Job's PER state, flow them to L1 via the commit, and then to requester via `close = requester` at settle time. Estimated savings: ~240k lamports per 3-bid auction. Skipped this round to keep the diff focused.
2. **Re-introduce private USDC settlement.** The Level C step 1 `live-usdc-tee` mode (entry t/u) was removed when settlement modes collapsed. Path back: keep `settle_auction` for SOL escrow + rent reclaim, add a new mode that runs `transferSpl(visibility:'private')` for the USDC payout while still reclaiming the SOL Job PDA via a `close_job` ix.
3. **Per-auction `max_bid_deposit > max_bid` for slack.** Currently we escrow exactly `max_bid`. For higher-stake auctions you might want extra to accommodate dynamic max raising mid-window. Not needed for the current demo.

---

## Where to read more

- [`PER-INTEGRATION-LOG.md` entry (w)](../PER-INTEGRATION-LOG.md) — full diagnosis, including the `Account<T>` → `AccountInfo` switch, the polling-for-undelegation client pattern, and balance reconciliation math.
- [`MAGICBLOCK-PER-KNOWLEDGE-PACK.md` §15](./MAGICBLOCK-PER-KNOWLEDGE-PACK.md) — added 4 new gotchas: exit-time-serialize fight with `commit_and_undelegate`, async undelegate completion polling, escrow-on-PDA pattern, ephemeral PDA rent flow.
- [`MILESTONE-LEVEL-C-3a.md`](./MILESTONE-LEVEL-C-3a.md) — the precursor (on-chain winner determination).
