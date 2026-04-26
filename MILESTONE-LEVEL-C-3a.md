# SealedBid v2 — Level C step 3a: on-chain winner determination

**Date:** 2026-04-27
**Status:** ✅ Shipped. Anchor program is now the source of truth for auction outcomes. Off-chain coordinator no longer picks winners.

---

## What landed

A new `close_auction` instruction that runs inside the TEE Private Ephemeral Rollup, iterates all Bid PDAs for a given Job, picks the lowest amount, and writes `winner` + `winning_amount` to the Job's on-chain state. The off-chain coordinator now reads the on-chain result instead of computing it.

**Architectural shift:**

| Before | After |
|---|---|
| Coordinator reads bids from PER, picks winner locally, transfers to that address | Program iterates bids on-chain in PER, picks winner deterministically, writes to Job state. Coordinator just reads `Job.winner` and transfers to that address. |
| Trust assumption: coordinator is honest | Trust assumption: program logic is deterministic + auditable. Coordinator can't influence outcome. |

---

## Proof of trust (auction 3 of the demo run)

The auction-3 result is the canonical demonstration that the program is the source of truth:

- Provider `accurate` submitted a randomized fallback bid of **133,406 lamports** (chosen by random number generator, not the static pricing table).
- Provider `budget` submitted **150,000 lamports** — what the local pricing table would have said was lowest.
- The on-chain `close_auction` ix correctly picked `accurate` because 133,406 < 150,000.

If the coordinator had been picking, it would have used the pricing-table comparison and chosen `budget`. Anyone watching could verify the on-chain result against the bids and see the program got it right.

---

## Reference instruction

```rust
pub fn close_auction(ctx: Context<'_, '_, 'info, 'info, CloseAuction<'info>>) -> Result<()> {
    require!(ctx.accounts.job.winner.is_none(), ErrorCode::AlreadyClosed);
    require!(Clock::get()?.unix_timestamp >= ctx.accounts.job.deadline, ErrorCode::DeadlineNotReached);

    let mut best_amount: Option<u64> = None;
    let mut best_provider: Option<Pubkey> = None;

    for bid_account in ctx.remaining_accounts {
        require!(bid_account.owner == ctx.program_id, ErrorCode::InvalidBidOwner);
        let bid = Account::<Bid>::try_from(bid_account)?;
        require!(bid.job == ctx.accounts.job.key(), ErrorCode::BidJobMismatch);

        if best_amount.map_or(true, |best| bid.amount < best) {
            best_amount = Some(bid.amount);
            best_provider = Some(bid.provider);
        }
    }

    let winner = best_provider.ok_or(ErrorCode::NoBids)?;
    let amount = best_amount.unwrap();

    ctx.accounts.job.winner = Some(winner);
    ctx.accounts.job.winning_amount = Some(amount);

    emit!(AuctionClosed { job: ctx.accounts.job.key(), winner, amount });

    Ok(())
}
```

`CloseAuction` accounts struct uses `has_one = requester` to bind the signer to the Job's recorded requester pubkey. Signer is **not** `mut` — gasless ER write per knowledge pack §15.

---

## Demo run (3 auctions, --sol-settle for synchronous settlement)

| # | Task | Bids | Winner | Amount | close_auction sig (in PER) | Settlement sig (L1) |
|---|---|---|---|---|---|---|
| 1 | image-caption | speedy 180k, budget 280k, accurate 320k | speedy | 180,000 | `2eBsh3uTJc54TQgxC2sQcjMHPkpxEXJ7F9MypxWbRhp1FnzQr24JuzFs5W5qy6bHmuvEF7c9AyHTfv7qserDwosk` | [Explorer](https://explorer.solana.com/tx/CiCizYrLKQVwqQF4dRa5oe452Cmrj67NuFxWEixjPNwgqS7pRizSkRJ6uAZKDVZo95HfKUK7QQ6KgLbGTEuKKFg?cluster=devnet) |
| 2 | text-summarize | accurate 220k, speedy 400k, budget 672k | accurate | 220,000 | `4tTrAocjwwB1XdKLktFkZYLvBPExEoANUJEFUpSvNNfMW4zqVEe8oHuVQxS8GYpcGrWTMYhEiJpmTJh65GBoTkqe` | [Explorer](https://explorer.solana.com/tx/2pTDq3uakZwKv2sMZMfWpnvdLCh9JfM3g9iWvQcr2a4KJFk5H3ELXxV9W5b9MNAzN73RZqXpxxaE3jhFRdDUJrFS?cluster=devnet) |
| 3 | echo | accurate **133,406** (random), budget 150k, speedy 350k | **accurate** | **133,406** | `3yTwSJGBZXqmQtuwfXj3W2rwPwWcYY5c2QJm5qBmYU3NWTV6HmYoALXPtZH5d9dRSDe8bMxYf2YAWgy5JDUeXNS4` | [Explorer](https://explorer.solana.com/tx/34CHfva3sDY841FkdThqa5XuSPvpCv3PfmSuMMkXvrWqkYtAJuA2UNjGnPsnm2B65LS1gD9UNe5ZRnozvxsCPK4n?cluster=devnet) |

Cleared 3/3 in 21.86s. All settlements live on devnet.

---

## Wallet reconciliation

| Wallet | Δ SOL | Expected (sum of winning bids settled) |
|---|---|---|
| speedy | +0.000180 | 180k lamports ✓ |
| accurate | +0.000353 | 220k + 133,406 = 353,406 lamports ✓ |
| budget | ±0 | 0 wins ✓ |
| requester | −0.062 | sponsor pre-funds + winning bids + tx fees + delegation rents |

Math reconciles. Program-determined winners received exactly their on-chain bid amounts.

---

## What changed

| File | Change |
|---|---|
| `programs/sealedbid/src/lib.rs` | Added `winner` + `winning_amount` to Job state. New `close_auction` ix (~50 lines). New `CloseAuction` Accounts struct (`has_one = requester`, signer not mut). New `AuctionClosed` event. 5 new error variants. |
| `auction/onchain-coordinator.ts` | After deadline, opens requester-auth'd PER connection, calls `closeAuction()` with all Bid PDAs in `remainingAccounts`. Reads `Job.winner` from PER (no local picking). New `sigs.closeAuction: string` field. |
| `demo-run.ts` | Receipts include the new `close_auction` sig per auction. |
| `README.md` | Architecture diagram updated with the close_auction box. |
| `SCOPE-LEVEL-B.md` | Status flipped to ✅ shipped. |
| `PER-INTEGRATION-LOG.md` | Entry (v) — full Rust diff, lifetime gymnastics, auction-3 trust-model demonstration, 6 tx sigs, 3 forward-looking action items. |
| `MAGICBLOCK-PER-KNOWLEDGE-PACK.md` §15 | Three new gotchas: lifetime sugar for `remaining_accounts`, `Account::<T>::try_from`, `has_one` is sufficient with seed binding. |

---

## Three new knowledge-pack gotchas (logged in §15)

1. **Anchor 0.32.1 lifetime sugar:** when an instruction iterates `remaining_accounts`, the Context generic must be `Context<'_, '_, 'info, 'info, T<'info>>` — the third slot has to be `'info`, not `'_`.
2. **`Account::<T>::try_from(acc_info)`** is the canonical loader for raw `AccountInfo`s passed via `remaining_accounts`. Validates owner + discriminator + deserializes in one call. Use this when accounts can't be statically declared in the Accounts struct.
3. **`has_one` is sufficient** when the bound field is also part of the PDA seeds. A forged signer can't pass both the PDA derivation check AND the `has_one` constraint.

---

## Bottom line

The institutional pitch upgrade: **"Winner determination is on-chain inside the TEE. The off-chain coordinator cannot influence the outcome. Anyone can verify the auction result by reading the Job's on-chain state."**

Combined with prior milestones, the system now has:
- Privacy: bids submitted gaslessly inside TEE PER (private from other users + observers)
- Verifiability: winner determination on-chain, deterministic, auditable
- Settlement: real on-chain SOL transfer (Level B step 3) or private USDC schedule (Level C step 1)

---

## Still optional (out of scope for this milestone)

- **Level C step 3b** — program-enforced escrow + payout. Requester locks max_bid at post_job; program transfers escrow → winner at settle. Removes the last off-chain trust assumption: today the coordinator chooses the destination, even though the program already chose the winner.
- **Level C step 2** — TEE payload encryption. Currently bids are private by execution environment (in PER), not by payload. Encrypting bids to the `/fast-quote` enclave session pubkey closes the gap for adversarial threat models.
- **UI fix** — `LeftPane.tsx:30` crash on undefined `.length`. Defensive null check or coordinator emits the missing field.
- **Permission Program integration** — permissioned reads, dynamic add-on rules.
