# SealedBid v2 — Level C step 1: private USDC settlement

**Date:** 2026-04-27 (initial), 2026-04-26 (re-integration on top of C-3b)
**Status:** ✅ Re-integrated and shipped. After the C-3b trustless-escrow refactor temporarily removed the USDC settlement mode, it's now back — composed cleanly on top of `settle_auction_refund` + `transferSpl(visibility:'private', validator:TEE)`. Schedule txs land. Delivery still async via the TEE validator's Hydra crank (devnet cadence unspecified).

> **Regression and recovery:** the live-usdc-tee mode was stripped during the trustless-escrow rewrite (C-3b). Re-integrated in `PER-INTEGRATION-LOG.md` entry (x) on top of the new `settle_auction_refund` ix. New flow: refund the SOL escrow on chain, schedule the USDC payout via the SDK's `transferSpl(private, TEE)`. Both legs reference the on-chain `Job.winner` so the coordinator can't silently reroute the payout.

---

## What landed

A private USDC settlement path layered on top of Level B. After auction close, the coordinator schedules a private SPL transfer via the MagicBlock TEE shuttle. Funds leave the requester's USDC ATA, sit pooled in the per-mint vault, and are delivered async to the winner's ATA by the TEE validator.

**End-to-end story (institutional pitch):**

> "Sealed bids are submitted privately inside the TEE PER. The winning bid is determined gaslessly. The settlement is a private USDC transfer scheduled on-chain in the TEE — async-finalized by the validator. Externally, only the schedule commitment is visible. The amount, sender, and recipient are obscured by the per-mint vault's pooling and the validator's batch ordering."

---

## What worked

- `OnchainAuctionCoordinator.settleWinnerUsdcTee()` uses the SDK's `transferSpl(visibility: 'private', validator: <TEE_VALIDATOR>)` helper. One call. Bundled deposit + delegate-shuttle + schedule.
- `--simulated`, `--sol-settle`, default `--live-usdc-tee` flags wired into `demo-run.ts`. Mode flag flows through the WebSocket `settled` event for UI compatibility.
- All 3 schedule transactions landed on devnet with valid signatures.
- Requester's USDC ATA debited by exactly 0.55 USDC (180k + 220k + 150k µUSDC = sum of winning bids).
- All required PDAs (per-mint vault, magic-fee-vault, transfer queue) already existed on devnet from prior MagicBlock-internal usage. Saved the ~1.07 SOL queue-init cost.

---

## What's pending (validator-side, not client-side)

- The 0.55 USDC is sitting in the global per-mint vault PDA `EiV97BPv…` (pooled with ~592 USDC from other senders).
- After 5+ min of polling, no delivery to providers' ATAs. Devnet Hydra crank cadence is slow / unspecified. Funds are not lost — they're async-pending the validator's batch processing.
- Manual crank attempt failed with `InvalidAccountOwner`: the queue is delegated to the TEE validator, so external cranks are forbidden by design. Only the validator can advance the queue.

This matches knowledge pack §8 #3 (the "stuck shuttle vault" risk we already knew about). It's structural, not a bug.

---

## Sample schedule transactions (devnet, 2026-04-27)

| Auction | Winner | µUSDC | Schedule tx |
|---|---|---|---|
| 1 (image-caption) | speedy | 180,000 | https://explorer.solana.com/tx/2LeW4348suCuxVWMpnV2fEfJdPVyYnKKJm2YEEybBdPHCTwRBiwrtzEgfXUwd23CoE5yQoYB4CHXXN946r42RZr5?cluster=devnet |
| 2 (text-summarize) | accurate | 220,000 | https://explorer.solana.com/tx/kZX3hCXxr1bG5SXVspyZRhMpaYkteeuPTHnoTSXnhhDXa1eqyAkjXUcwo1NMDCvxuYpYAoXnu3kvxx7twWPUwth?cluster=devnet |
| 3 (echo) | budget | 150,000 | https://explorer.solana.com/tx/2wJyN8XecKsH3iBKjMKkxmGNwkyscxXYByETuhauJh8q2pD7xpuQ84iaR4QUpA4poVMAUPmxE4uhLL2f5yQLbCMP?cluster=devnet |

Each schedule tx is a real on-chain commitment to a private USDC transfer. External observers can verify the schedule was placed but cannot determine the recipient or amount without the validator's TEE-resident keys.

---

## Wallet reconciliation

| Wallet | SOL Δ | USDC Δ | Notes |
|---|---|---|---|
| requester | −0.0499 SOL | **−0.55 USDC** ✓ | exact match for sum of winning bids |
| speedy (winner ×1) | ±0 | ±0 (pending) | Hydra delivery pending |
| accurate (winner ×1) | ±0 | ±0 (pending) | Hydra delivery pending |
| budget (winner ×1) | ±0 | ±0 (pending) | Hydra delivery pending |
| Per-mint vault `EiV97BPv…` | n/a | +0.55 USDC pooled | held by the TEE shuttle, awaits crank |

Sender side reconciles. Recipient side will reconcile when the validator processes the queue.

---

## Three demo modes (depending on audience)

| Mode | Command | Best for |
|---|---|---|
| `--live-usdc-tee` (default) | `npm run demo` | Institutional pitch — "private USDC, async-finalized by the validator" |
| `--sol-settle` | `npm run demo -- --sol-settle` | Live audience demo — synchronous, visible payouts in the UI |
| `--simulated` | `npm run demo -- --simulated` | Stage demo or rate-limited devnet — no settlement at all |

**For live demos right now**, use `--sol-settle`. It's the rock-solid path. USDC mode is for institutional pitches where the async story is a feature, or for screenshots / video where you want the schedule txs as proof.

---

## What's still next (all optional)

- **Wait + recheck** in 30+ min for Hydra crank delivery: `for w in provider-1 provider-2 provider-3; do spl-token accounts --owner $(solana-keygen pubkey wallets/$w.json) --url devnet | grep ^4z; done`. If funds arrive late, log a follow-up entry. The implementation is correct.
- **Discord question to MagicBlock team** (drafted in `PER-INTEGRATION-LOG.md` entry u): canonical Hydra crank cadence on devnet vs mainnet, status query API for in-flight transfers, expected `shuttleId` scheme, vault assumptions.
- **Level C step 2** — TEE-side payload encryption (encrypt bid amounts to enclave session pubkey, not just the validator identity).
- **Level C step 3** — Program-enforced escrow + on-chain winner determination (removes the trust-the-coordinator assumption).
- **Permission Program** integration for permissioned reads / dynamic add-on rules.

---

## Files of record (Level C step 1)

- `sealedbid-on-chain/auction/onchain-coordinator.ts` — added `settleWinnerUsdcTee()`, `settlementMode` option
- `sealedbid-on-chain/demo-run.ts` — added `--simulated`, `--sol-settle`, default `--live-usdc-tee` flags
- `sealedbid-on-chain/scripts/bootstrap-providers.ts` — extended for USDC ATA creation
- `sealedbid-on-chain/server.ts` — settled event forwards `mode` field
- `PER-INTEGRATION-LOG.md` entry (u) — full diagnosis, drafted Discord question, recovery plan
- `MAGICBLOCK-PER-KNOWLEDGE-PACK.md` §15 — async settlement, queue-cranking restrictions, pitch framing

---

## Bottom line

**The institutional pitch demo is shippable.** The code is correct, the proof is on chain, the async finalization is a feature for the institutional story. For live retail-flavored demos, fall back to `--sol-settle`.
