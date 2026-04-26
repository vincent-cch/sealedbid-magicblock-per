# Level B Scope — Auction state on-chain via Anchor program + PER

**Status:** ✅ **shipped, including Level C step 3a (on-chain winner determination).** Program deployed to `5JaacAzrnj…` on devnet. The `close_auction` instruction now picks the winner inside the program, executing inside the TEE PER. The off-chain coordinator just orchestrates — it doesn't decide who wins. See PER-INTEGRATION-LOG.md entry (v) for receipts.

**What changes vs Level A:** the auction is no longer in Node memory. A small Anchor program holds Job, Bid, and Result PDAs. PDAs are delegated to a Private Ephemeral Rollup on the TEE validator (`MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`). The coordinator becomes a thin transaction dispatcher.

**What this unlocks:**
- Real TEE-side reveal — the auction logic runs *inside* the TDX-protected validator, with cleartext access to bids during `close_auction`. Closes the structural gap from Level A milestone 5 (entry (g) in `PER-INTEGRATION-LOG.md`).
- Every state change is auditable on Solana — final committed state lands on the base layer.
- Bid plaintexts are NOT encrypted on the wire. Confidentiality comes from the **Permission Program** + **TEE-protected ephemeral RPC**, not from client-side crypto. Cleaner than Level A's "encrypt to validator pubkey" simulation.

---

## 1. Account layouts

All accounts are **plaintext PDAs**. Confidentiality is enforced at the RPC/permission layer, not in account data.

### Job PDA
```
seeds = [b"job", requester.key().as_ref(), &job_nonce.to_le_bytes()]
fields:
    requester: Pubkey         // who posted the job
    task_type: u8             // enum: image-caption, transcribe, etc.
    max_bid: u64              // lamports ceiling
    deadline: i64             // unix-seconds, auction closes
    status: JobStatus         // Open | Closing | Closed
    bid_count: u32            // how many bids submitted (incremented atomically)
    job_nonce: u64            // for PDA uniqueness
```
**Read:** all session participants (providers + requester + program authority). **Write:** program-only.

### Bid PDA
```
seeds = [b"bid", job_pda.as_ref(), provider.key().as_ref()]
fields:
    job: Pubkey               // back-pointer
    provider: Pubkey          // bidder
    amount_lamports: u64      // bid price
    confidence: u16           // 0..10000 (basis points)
    submitted_at: i64
```
**Read:** restricted to `provider` + program authority (via Permission PDA). **Write:** program-only via `submit_bid` instruction signed by `provider`.

One Bid PDA per (job, provider). The PDA seeding makes it impossible for a provider to submit multiple bids on the same job.

### Result PDA
```
seeds = [b"result", job_pda.as_ref()]
fields:
    job: Pubkey
    winner: Pubkey
    winning_amount: u64
    runner_up_amount: u64     // Vickrey-style optional; for now = winning_amount
    output_hash: [u8; 32]     // filled in by settle()
    settled_at: i64
```
**Read:** public (all authenticated session participants). **Write:** program-only via `close_auction` (initial fields) and `settle` (output_hash + settled_at).

---

## 2. Instructions

### `post_job(task_type: u8, max_bid: u64, deadline: i64, job_nonce: u64)`
Signer: `requester`. Effects:
1. Init Job PDA with `status = Open`.
2. Init Permission PDA on the Job, members = `[requester, program_authority, ...active_providers]` with `TX_LOGS_FLAG | TX_MESSAGE_FLAG`. (See §4 for "active_providers" sourcing.)
3. Delegate Job PDA + its Permission PDA to the TEE validator.
4. Emit `JobPosted` event.

### `submit_bid(amount_lamports: u64, confidence: u16)`
Signer: `provider`. Constraints: `provider != job.requester`, `amount_lamports <= job.max_bid`, `now < job.deadline`, no existing Bid PDA for this (job, provider). Effects:
1. Init Bid PDA.
2. Init Permission PDA on the Bid with members = `[(provider, TX_LOGS_FLAG|TX_MESSAGE_FLAG), (program_authority, AUTHORITY_FLAG)]`. **No other reader.**
3. Delegate Bid PDA + its Permission PDA to the TEE validator.
4. Increment `job.bid_count`.
5. Emit `BidSubmitted` event (provider visible; amount NOT in event payload — the event leaks bidder identity but not bid amount, and that's intentional for live UI).

### `close_auction(job_nonce: u64)`
Signer: anyone (idempotent), ideally a crank or the requester. Constraints: `now >= job.deadline`, `job.status == Open`. Effects (all atomic, all running inside the TEE):
1. Set `job.status = Closing`.
2. Iterate over all Bid PDAs for this job (passed as `remaining_accounts`; the program reads them in cleartext because the TEE protects the validator memory).
3. Pick winner: lowest `amount_lamports`, ties broken by highest `confidence`.
4. Init Result PDA with winner + winning_amount.
5. Atomically commit + undelegate (`createCommitAndUndelegatePermissionInstruction` semantics — both Job and all Bid PDAs lift back to Solana base layer in one transaction).
6. Set `job.status = Closed`.
7. Emit `AuctionClosed` event with winner + winning_amount.

**This is the critical instruction.** Bid plaintext is only readable inside the TEE during this instruction's execution. Once it commits back to Solana, observers on the base layer see the Bid PDA contents — but by then the auction is over and the bids are public anyway as part of audit (or we close the Bid PDAs in this same instruction; see §5).

### `settle(job_nonce: u64, output_hash: [u8; 32])`
Signer: `result.winner` only. Effects:
1. Verify `job.status == Closed` and `result.winner == ctx.accounts.winner.key()`.
2. Transfer `result.winning_amount` lamports from `requester`'s escrow PDA to `winner`.
3. Write `output_hash` and `settled_at` to Result.
4. Emit `Settled` event.

For Level B, settlement is plain-SOL on the base layer (post-undelegation). Level C replaces this with the private TEE transfer flow.

---

## 3. Delegation lifecycle

| When | What happens |
|---|---|
| `post_job` | Job PDA + Job Permission PDA delegated to TEE validator. Job is now reachable only via ephemeral RPC for in-session reads/writes. |
| `submit_bid` | Bid PDA + Bid Permission PDA delegated to TEE validator. Provider submits via ephemeral RPC after `getAuthToken`. |
| `close_auction` | All Bid PDAs and the Job PDA atomically commit + undelegate via `createCommitAndUndelegatePermissionInstruction`. State lands on Solana base layer. Result PDA initialized on Solana directly (never delegated, since it's public-read post-close). |
| `settle` | Runs on base layer (no PER session needed). Plain SPL/SOL transfer from escrow to winner. |

**Permission Program ID:** `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1`
**Delegation Program ID:** `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`

The Permission Program docs explicitly state delegation must be atomic: when the permissioned account is delegated, its Permission PDA is delegated in the same transaction. We use `createDelegatePermissionInstruction` which handles this, passing `validator: TEE_VALIDATOR_PUBKEY` to target the TEE specifically (the SDK auto-selects a public ER if `validator` is omitted — see knowledge pack §8 gotcha #1).

---

## 4. Permission setup — exact SDK calls

**Important correction to the original brief:** `createEataPermissionIx` / `delegateEataPermissionIx` are for **Ephemeral Associated Token Accounts (SPL token accounts)**, not generic PDAs. For Bid/Job/Result PDAs we use the generic Permission Program instructions.

### Bid PDA — restricted-read (provider + program only)

In our Anchor program we build instructions equivalent to:

```ts
import {
  createCreatePermissionInstruction,
  createDelegatePermissionInstruction,
  AUTHORITY_FLAG,
  TX_LOGS_FLAG,
  TX_MESSAGE_FLAG,
} from '@magicblock-labs/ephemeral-rollups-sdk';

// 1. Create the Permission PDA bound to the Bid PDA, with a 2-member ACL
const createPermIx = createCreatePermissionInstruction(
  { permissionedAccount: bidPda, payer: provider },
  {
    members: [
      { flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG, pubkey: provider },
      { flags: AUTHORITY_FLAG, pubkey: programAuthority },
    ],
  },
);

// 2. Atomically delegate Bid PDA + its Permission PDA to the TEE validator
const delegateIx = createDelegatePermissionInstruction(
  {
    payer: provider,
    authority: [provider, true],         // [pubkey, isSigner]
    permissionedAccount: [bidPda, false],
    ownerProgram: SEALEDBID_PROGRAM_ID,
    validator: TEE_VALIDATOR_PUBKEY,     // pin to TEE — don't let SDK auto-select Asia
  },
);
```

**Inside the Anchor program**, both ix become CPIs to the Permission Program with the same arg layout. We can mirror them via the on-chain `cpi::*` helpers from the `ephemeral-rollups-sdk` Rust crate.

**Member flags reference** (`access-control/types/member.d.ts`):
- `AUTHORITY_FLAG` — can update the permission member list (admin)
- `TX_LOGS_FLAG` — can read transaction logs touching this account
- `TX_BALANCES_FLAG` — can read balance changes
- `TX_MESSAGE_FLAG` — can read transaction message bodies
- `ACCOUNT_SIGNATURES_FLAG` — can read signatures involving this account

For Bid PDAs, `TX_LOGS_FLAG | TX_MESSAGE_FLAG` is the minimum a provider needs to verify their own bid landed. The program authority gets `AUTHORITY_FLAG` so it can amend the member list later if needed.

### Job PDA — broader read (all session participants)

Same `createCreatePermissionInstruction` call but with `members` listing the requester + program authority + all currently-active provider pubkeys. **Open implementation question:** how is "currently active" determined? Three options:
- (a) Static at post_job time: requester pre-registers a provider whitelist. Simplest, least flexible.
- (b) Dynamic: each `submit_bid` call adds the bidder via `createUpdatePermissionInstruction` to the Job's Permission PDA. More work per bid.
- (c) Wildcard "any authenticated session" if the Permission Program supports it. Need to confirm with MagicBlock — the SDK types don't show a wildcard option, only enumerated `Member[]`.

**Recommendation:** start with (a) for the demo. Migrate to (b) if the live-bidder UX needs it.

### Result PDA — public read

After `close_auction` commits state back to Solana, the Result PDA is on the base layer and readable by anyone via the standard Solana RPC. No Permission PDA needed (the Permission Program gates the *PER* read path, not the base-layer read path).

### Helpers worth using
- `permissionPdaFromAccount(account: PublicKey)` — derive the Permission PDA address client-side.
- `getPermissionStatus(rpcUrl, publicKey)` — verify the permission is live (returns `{ authorizedUsers }`).
- `waitUntilPermissionActive(rpcUrl, publicKey, timeout)` — block until propagation completes; useful in submit_bid client flow before the next RPC call.

---

## 5. Security notes — who reads what, when

The key insight: **the Anchor program running inside the TEE is the trust boundary, not client-side encryption.** The validator is honest because it runs in a TDX enclave; the program is correct because it's audited Rust. Confidentiality flows from those two properties through the Permission Program's RPC-level access gates.

### Read access matrix

| Account | While delegated to PER | After `close_auction` commits to Solana |
|---|---|---|
| **Job PDA** | Readable via ephemeral RPC by members of Job's Permission PDA (requester + program + active providers). Base layer shows last-committed state (could be stale). | Readable by anyone via Solana RPC. |
| **Bid PDA** | Readable via ephemeral RPC by Bid's permission members ONLY (this provider + program authority). NO other provider can see this bid. Base layer shows last-committed state, which for a fresh delegation is the init values (no amount yet). | **Becomes publicly readable.** Mitigation: `close_auction` should `close_account` on each Bid PDA in the same instruction, so the Bid PDA is dropped from the chain immediately. The winner's bid amount survives in the Result PDA; loser bids are erased. |
| **Result PDA** | Not delegated. Initialized on base layer by `close_auction`. | Public-read. |

### Threat model — what we're protecting against, what we're not

**Protecting against:**
1. *Provider B reading Provider A's bid before close.* Permission Program restricts ephemeral-RPC reads on Bid PDAs to (provider, program_authority). B querying the ephemeral RPC for A's Bid PDA gets an unauthorized response.
2. *Validator operator reading bids.* The validator runs in a TDX enclave (verified via `verifyTeeRpcIntegrity`). The operating company can't introspect validator memory.
3. *Network observer reading bids.* TLS to ephemeral RPC + TEE-resident state means wire payloads are encrypted in transit and decrypted only inside the enclave.

**NOT protecting against:**
1. *A malicious program.* If the Anchor program has a bug that emits bid amounts in events, all of the above is moot. The program is the trust boundary — its source must be audited.
2. *A malicious requester colluding with one provider.* The requester knows the Job; if they share auction details out-of-band, that's a meta-game problem outside the protocol.
3. *Post-close audit.* Once `close_auction` commits, all bids become readable (modulo the close_account mitigation above). Sealed-bid is a *temporal* privacy guarantee: confidential during the auction, public after. If we want permanent bid privacy, that's Level C with private settlement and Bid PDAs that are never committed back as cleartext.
4. *Side-channel attacks on TDX itself.* Out of scope. Trust the hardware vendor.

### Why no client-side encryption

In Level A we encrypted bids against the validator pubkey on the wire because there was nowhere to put cleartext bids that wasn't observable. In Level B, the entire path from `submit_bid` transaction through close_auction execution lives inside the TEE — the wire is TLS, the validator is enclave-protected, the storage is permission-gated. **Adding client-side encryption on top would just hide cleartext from the program itself, defeating the point** (the program needs to read the amount to compare bids). Level B's confidentiality is structural; Level A's was crypto-as-substitute-for-structure.

---

## 6. Build order (when we start)

1. Anchor scaffold: program ID, accounts, instructions stubbed.
2. Implement `post_job` + `submit_bid` (no permissions, no delegation yet) and verify on devnet base layer.
3. Add Permission PDAs on Bid + Job. Verify ACL with `getPermissionStatus`.
4. Add delegation to TEE on `post_job` + `submit_bid`. Verify via `npm run check-per`-shaped flow that the PDAs are reachable through the ephemeral RPC.
5. Implement `close_auction` with `createCommitAndUndelegatePermissionInstruction`. Confirm state lands on base layer post-undelegate.
6. Implement `settle`.
7. Replace the Node coordinator's role with a thin TX dispatcher: `coordinator.runAuction` becomes a sequence of program ix dispatches.
8. Update demo-run.ts to use the new flow. Update SLIDES.md to reflect Level B.

---

## 7. Open questions to resolve before kicking off

1. **Active-provider sourcing for Job Permission PDA** (§4). Pick (a), (b), or (c) above.
2. **Bid PDA close-on-auction-close.** Should `close_auction` close all Bid PDAs in the same instruction to keep losing bids private even after the auction? Tradeoff: rent recovery vs. one-shot extra CPI cost.
3. **Anchor vs raw Solana program.** Anchor adds runtime overhead but speeds development. Recommend Anchor for demo; revisit if perf matters.
4. **Single auction or multi-auction state?** Level A demo runs 1+ auctions per process. Level B should support N concurrent jobs without state collisions — Job PDA seeds include `job_nonce` precisely for this.
5. **Crank/cron for `close_auction`.** Who actually calls it after `deadline`? Options: requester does it, a crank service does it, anyone can do it (we should make it permissionless to avoid liveness issues).

---

## 8. Out of scope for Level B

- Private settlement (Level C — uses `payments.magicblock.app/v1/spl/transfer` with `visibility: 'private'`).
- USDC instead of SOL (Level C).
- Vickrey second-price clearing logic (could fit in Level B but adds complexity; default is first-price descending).
- Multi-round auctions, English auctions, anything other than one-shot sealed-bid.

---

## References

- `MAGICBLOCK-PER-KNOWLEDGE-PACK.md` §2 (program IDs), §4 (auth flow), §15 (build-time decisions)
- `PER-INTEGRATION-LOG.md` entries (e), (f), (g) — milestones 3, 4, 5
- `node_modules/@magicblock-labs/ephemeral-rollups-sdk/lib/instructions/permission-program/` — actual instruction source
- `node_modules/@magicblock-labs/ephemeral-rollups-sdk/lib/access-control/types/` — Member flags, MembersArgs
- https://github.com/magicblock-labs/private-payments-demo — Anchor + PER reference (study before writing Rust)
- https://github.com/magicblock-labs/delegation-program — delegation program source
