# MagicBlock PER Knowledge Pack

Single reference for the SealedBid v2 build. Hand this to Claude Code along with `SEALEDBID-V2-ON-CHAIN-SPEC.md`. Everything Claude Code needs to know is in here or linked from here.

Last updated: 2026-04-25

---

## 1. Endpoints (verified from docs.magicblock.gg)

### Devnet
| Region | RPC URL | Validator pubkey |
|--------|---------|------------------|
| Asia | `devnet-as.magicblock.app` | `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` |
| EU | `devnet-eu.magicblock.app` | `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e` |
| US | `devnet-us.magicblock.app` | `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd` |
| **TEE** | **`devnet-tee.magicblock.app`** | **`MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`** |

### Mainnet
| Region | RPC URL | Validator pubkey |
|--------|---------|------------------|
| Asia | `as.magicblock.app` | `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` |
| EU | `eu.magicblock.app` | `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e` |
| US | `us.magicblock.app` | `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd` |
| **TEE** | **`mainnet-tee.magicblock.app`** | **`MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`** |

### Localnet
- Local ER: `localhost:7799`

> ✅ **CONFIRMED 2026-04-25 by MagicBlock team:** devnet TEE validator is `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` and the endpoint is healthy. Use this. The old `FnE6...` address from the March debug log is stale, ignore it.

---

## 2. Core programs (CPI targets)

| Program | Pubkey |
|---------|--------|
| Permission Program | `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1` |
| Delegation Program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |

### Permission Program: what it does
Builds programs with permission and delegation hooks. After delegation, the permissioned account is delegated to the TEE validator atomically. A symmetric `undelegate` instruction releases both accounts atomically when returning to base layer (Solana mainnet).

---

## 3. SDK packages

| Package | Purpose | Version |
|---------|---------|---------|
| `@magicblock-labs/ephemeral-rollups-sdk` | TS helper for `@solana/web3.js` | **^0.11.1** |
| `@magicblock-labs/ephemeral-rollups-kit` | TS helper for `@solana/kit` | latest |
| `ephemeral-rollups-sdk` (Rust crate) | Rust on-chain integration | latest |
| `magic-resolver` (Rust crate) | Connection resolution | latest |

> ⚠️ **2026-04-25 TEE migration:** MagicBlock migrated the devnet TEE server. SDK 0.8.5 has two contract skews against the migrated server (`/quote` 32 vs 64 byte challenge, and `hclVarDataSha256` vs `reportDataSha256` field name). **Use `^0.11.1` for any new PER work.** Confirmed by MagicBlock team. See `PER-INTEGRATION-LOG.md` for the full debug trail.

`hackathon-sealedbid` (frozen stage demo) stays on `^0.8.5` because it doesn't touch the TEE attestation path. `sealedbid-on-chain` is on `^0.11.1`.

---

## 4. The TEE authentication flow (verbatim from docs)

```typescript
import {
  verifyTeeRpcIntegrity,
  getAuthToken,
} from "@magicblock-labs/ephemeral-rollups-sdk";

// Step 1: Verify the integrity of the TEE RPC
// Hits https://pccs.phala.network/tdx/certification/v4 to validate the
// TDX enclave attestation
await verifyTeeRpcIntegrity(EPHEMERAL_RPC_URL);

// Step 2: Get an auth token before making requests to the TEE
const token = await getAuthToken(
  EPHEMERAL_RPC_URL,
  wallet.publicKey,
  (message: Uint8Array) => /* sign with your wallet */,
);
```

After getting `token`, create the ephemeral connection:

```typescript
const ephemeralUrl = `${EPHEMERAL_RPC_URL}?token=${token}`;
const ephemeralRpc = new Connection(ephemeralUrl, 'confirmed');
```

This is the exact pattern your existing `agentic-commerce/solana-pay-agent-poc/per-proper-flow.mjs` already uses (minus `verifyTeeRpcIntegrity`, which is new in 0.8+ and you should add).

---

## 5. SDK exports you'll need

From your existing `per-proper-flow.mjs`, you're already using:

```typescript
import {
  getAuthToken,
  deriveEphemeralAta,
  deriveVault,
  initEphemeralAtaIx,
  initVaultIx,
  initVaultAtaIx,
  delegateIx,
  transferToVaultIx,
  undelegateIx,
  withdrawSplIx,
  createEataPermissionIx,
  delegateEataPermissionIx,
} from '@magicblock-labs/ephemeral-rollups-sdk';
```

For SealedBid v2, you'll likely also need:
- `verifyTeeRpcIntegrity` (NEW, 0.8+)
- The encryption helper for sealing data against the enclave (check the SDK source)

---

## 6. Reference projects (study these in order)

| Project | Why it matters |
|---------|----------------|
| https://github.com/magicblock-labs/private-payments-demo | The closest official reference: Next.js + Anchor + PER. Read this end-to-end. Uses `@magicblock-labs/ephemeral-rollups-sdk: ^0.8.5` (same as you). |
| https://github.com/akshaydhayal/MagicBlock-Shield-Poker | Community sealed-bid implementation using PER. Sealed cards are conceptually identical to sealed bids. Read the README + program code. |
| https://github.com/magicblock-labs/magicblock-engine-examples | Official integration examples (anchor-counter, bolt-counter). The minimal "how do I delegate an account and run instructions in an ER" reference. |
| https://github.com/magicblock-labs/delegation-program | The delegation program source. Read if you need to understand what delegation actually does. |

---

## 7. Documentation URLs

| URL | What's there |
|-----|--------------|
| https://docs.magicblock.gg/ | Main docs site |
| https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/quickstart | PER quickstart (READ THIS FIRST) |
| https://docs.magicblock.gg/pages/tools/tee/introduction | TEE concept overview |
| https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/access-control | Access control docs (relevant for permissioned accounts) |
| https://docs.magicblock.gg/Accelerate/ephemeral_rollups | ER intro (less PER-specific) |
| https://github.com/magicblock-labs/ephemeral-rollups-sdk | SDK source + README |
| https://www.magicblock.xyz/solana-privacy | Marketing page (good for understanding positioning) |

---

## 8. Known gotchas (from your own debug log + docs)

### From your `PER-DEBUG-LOG.md`
1. **API auto-selects wrong validator.** When you call `payments.magicblock.app/v1/spl/transfer` with `visibility: 'private'`, the API picks the Asia validator instead of TEE. **Fix:** explicitly pass `validator: <TEE pubkey>` in your request body.
2. **TEE validator queue init costs ~1.07 SOL.** First time using a token mint on the TEE validator, you have to fund the transfer queue rent. If your wallet has less than ~1.1 SOL, init will fail.
3. **Stuck shuttle vault.** If a private transfer fails mid-flow, USDC can get stuck in the shuttle vault PDA. Recovery requires the right validator processing the unstick. Don't burn through funds testing.
4. **Public ≠ private code paths.** Public transfers do direct SPL Transfer in the same TX. Private transfers deposit to a shuttle vault and rely on async TEE processing. Different failure modes.

### From the docs
1. **Latest Permission Program requires SDK >= 0.8.0.** You're on 0.8.5. Good.
2. **Permission + Delegation programs must be invoked atomically.** The docs explicitly note this.

### Likely fresh gotchas you'll discover
- TEE attestation might fail intermittently if Phala's PCCS endpoint is down
- Auth tokens probably expire (test how long they last)
- The devnet TEE may not have all token mints initialized

---

## 9. Discord & support

When stuck, the MagicBlock Discord is the highest-bandwidth channel:
- **Discord:** https://discord.com/invite/MBkdC3gxcv
- Status: docs say PER is "under testing" — reach out for testing endpoint access if devnet TEE doesn't work for you

---

## 10. Recommended build order for SealedBid v2 Level A

1. **Health check first.** Build `npm run check-per` that:
   - Calls `verifyTeeRpcIntegrity('https://devnet-tee.magicblock.app')`
   - Calls `getAuthToken()` for the requester wallet
   - Prints the resulting auth token (truncated)
   - PASS or FAIL with a clear error
2. **Once health-check passes,** open an actual Connection against the ephemeral RPC and run a no-op query (e.g. `getVersion()`)
3. **Then** wire in the real enclave-key bid sealing
4. **Then** the reveal happening server-side using the ephemeral RPC
5. **Last**: update the UI's connection badge to show real TEE status

If step 1 fails, stop and ping MagicBlock Discord. Don't move forward.

---

## 11. Stage-day fallback plan

If on stage day the v2 demo's PER session is broken (devnet TEE down, attestation failing, whatever):
- The original `hackathon-sealedbid` is untouched and still works
- Run that one
- Save v2 for a follow-up demo when MagicBlock infra is reliable

The whole reason you forked was to keep the working version safe. Don't overwrite it.

---

## 12. What to ask MagicBlock team before starting

Send this in their Discord:

```
Hi team — quick sanity check before starting a project on PER devnet.

1. Is devnet-tee.magicblock.app currently healthy? Should attestation via 
   pccs.phala.network/tdx/certification/v4 work for it right now?

2. Confirming the devnet TEE validator pubkey is 
   MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo (per the quickstart docs).
   I have an older note that lists FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA — 
   has that changed?

3. For a sealed-bid auction use case (encrypt bids against the enclave's
   session pubkey, decrypt server-side inside the TEE), which SDK function
   exposes the enclave's session pubkey post-getAuthToken? Or is the 
   session pubkey embedded in the auth token response?

4. Is there a known-good devnet test wallet/program I can fork from to skip 
   the TEE queue init cost on devnet?

Thanks — happy to share what I'm building if useful.
```

---

## 13. Hand-off prompt for Claude Code

When v2 development starts, paste this exact prompt to Claude Code (after duplicating the project per the v2 spec):

```
Read these two docs in order before writing any code:
1. ../MAGICBLOCK-PER-KNOWLEDGE-PACK.md (this file)
2. ../SEALEDBID-V2-ON-CHAIN-SPEC.md

Use the verbatim TEE flow from section 4 of the knowledge pack. Use 
devnet-tee.magicblock.app as EPHEMERAL_RPC_URL. Use the validator pubkey 
from section 1 (MTEWGu...3n3xzo).

Implement Level A milestone 1 ONLY: `npm run check-per` returns PASS.

If verifyTeeRpcIntegrity or getAuthToken fails, do NOT silently fall back. 
Print the full error and stop. Tell me what failed so we can ask MagicBlock 
team about it. Do not proceed to milestone 2 until milestone 1 passes.
```

---

## 14. Hard-won learnings (running log — keep updating)

Every painful gotcha goes here so the next person (or future-you) doesn't repeat it. Newest at top. Append to this section as v2 progresses, never delete.

### 2026-04-25 — TEE migration broke SDK 0.8.5

**What happened.** Started v2 with `@magicblock-labs/ephemeral-rollups-sdk@0.8.5` (same version as the working hackathon scaffold). `verifyTeeRpcIntegrity` and `verifyTeeIntegrity` both failed against `devnet-tee.magicblock.app` with two distinct contract skews:
- `/quote` rejects 32-byte challenge with HTTP 500 "challenge must decode to 64 bytes". SDK 0.8.5 sends 32 bytes.
- `/fast-quote` returns `reportDataSha256` field; SDK 0.8.5 reads `hclVarDataSha256` → TypeError on undefined Buffer.

**Resolution.** MagicBlock team confirmed the TEE was migrated. **Required SDK bump: 0.8.5 → 0.11.1.** Canonical pattern (`verifyTeeRpcIntegrity` → `getAuthToken`) works on 0.11.1. Stop using 0.8.5 for any TEE attestation.

**Lesson.** Before starting a new PER project, check the SDK version against the most recent MagicBlock blog/Discord posts. The TEE side and the SDK side migrate together.

### 2026-04-25 — Don't throw out existing workarounds blindly

**What happened.** Found an "elaborate" `check-per.ts` in the duplicated fork that used `/fast-quote` + `dcap-qvl` directly. Replaced it with the canonical `verifyTeeRpcIntegrity` pattern from docs. Both 0.8.5 paths failed. The elaborate version was probably a previously-working workaround for the exact bugs we then re-discovered.

**Lesson.** When you find non-obvious code that someone clearly debugged into existence, treat it as load-bearing until you can prove it isn't. Comment first, replace second.

### 2026-04-25 — Devnet TEE validator address rotated

**What happened.** Old debug log (March 2026) had devnet TEE validator as `FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA`. Current correct value is `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` (same as mainnet TEE). Confirmed by MagicBlock team.

**Lesson.** Don't trust addresses from debug logs older than 4 weeks. Always sanity-check against the live docs and ask the team in Discord if anything looks off.

### 2026-03-30 (carried forward from PER-DEBUG-LOG.md) — `payments.magicblock.app` API auto-selects wrong validator

**What happened.** When calling `payments.magicblock.app/v1/spl/transfer` with `visibility: 'private'`, the API picked the Asia validator (`MAS1...`) instead of the TEE validator. Funds got stuck in the shuttle vault PDA because the regional validator can't process private transfers.

**Resolution.** Always pass `validator: <TEE pubkey>` explicitly in the request body. Don't trust the auto-selection.

### 2026-03-30 (carried forward) — TEE validator queue init costs ~1.07 SOL

**What happened.** First time using a token mint on the TEE validator, you have to fund the transfer queue rent. Failed initialization with "insufficient lamports 291672405, need 1068375040".

**Lesson.** For SPL token (USDC) work on TEE, fund the operating wallet to >1.1 SOL before starting. SOL transfers don't need this; only SPL.

### 2026-03-30 (carried forward) — Public vs private use different code paths

**What happened.** Public transfers do direct SPL Transfer in the same TX. Private transfers deposit to a shuttle vault and rely on async TEE processing. They have different failure modes.

**Lesson.** Don't assume "if public works, private will too." Test both independently.

### 2026-03-30 (carried forward) — Stuck shuttle vault is a real risk

**What happened.** When a private transfer flow fails mid-way, USDC can land in the shuttle vault PDA and get stuck. Recovery requires the right validator processing the unstick. Manual recovery is hard because the vault is owned by the MagicBlock SPL program PDA.

**Lesson.** Use small amounts when testing private transfers. Don't pump 100 USDC into your first test transfer.

---

## 15. Build-time decisions worth remembering

These aren't bugs, they're tradeoffs we made deliberately. Document them here so future-you doesn't relitigate the same questions.

### Style B: simulated auctions + occasional live settlements

For the v1 hackathon demo, we chose to run most auctions in-memory with sealed-bid simulation, with every Nth auction (originally 1, then 6) doing a real on-chain settlement. **Why:** running every auction live caused devnet rate limits, settlement latency, and on-stage failure risk. Style B kept the demo bulletproof while still proving on-chain capability.

### Off-chain coordinator (v1) vs on-chain Solana program (v2)

V1 keeps the coordinator off-chain, in Node memory. V2 aims to move auction state into a Solana program delegated to a PER session. The off-chain version is faster to ship and demo. The on-chain version is the actual product shape.

### TDX seal: simulated nacl box (v1) vs real PER enclave key (v2)

V1 simulates the TEE seal with a local nacl keypair. The audience can't tell the difference visually. V2 uses the real enclave session pubkey from the PER. Same crypto primitive (X25519 box), but with a hardware-attested key.

### Devnet only, ever (until proven)

Never test on mainnet until devnet is rock-solid AND you've replayed the full flow at least 5 times. The 1.07 SOL queue init cost alone makes mainnet testing painful.

### Self-healing bootstrap > rigid setup steps

The `bootstrapProviders()` script that auto-funds providers from the requester saved us when devnet airdrops rate-limited. Pattern: detect missing state and heal it lazily, instead of forcing the user through a setup wizard. Apply this to v2.

### v2 Level A uses validator pubkey for encryption (not enclave session pubkey)

For Level A bid sealing, `sealedbid-on-chain` encrypts bids against the **TEE validator identity pubkey** (`MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` on devnet) using the same primitive the SDK uses internally for `schedulePrivateTransferIx` (`encryptEd25519Recipient`: ed25519→X25519 + nacl.box + blake2b nonce). **Not the enclave session pubkey from `/fast-quote.pubkey`.**

**Why:** demo speed and SDK alignment, not production threat model. The SDK already implements this path — we just inline it (the helper isn't in the package's `exports` map). It matches MagicBlock's own private-transfer flow byte-for-byte, so a future TDX-side decrypt would still work.

**For production sealed-bid threat model, switch to the `/fast-quote` enclave key.** That pubkey is TDX-attested (`reportData[0:64] === sha512(pubkey)`), distinct from the validator identity, and stable per session — see milestone 3 findings in `PER-INTEGRATION-LOG.md` entry (e). The Discord question on which pubkey is canonically correct stays open. It's a Level C decision, not a Level A blocker.

### v1 and v2 intentionally on different SDK versions — DO NOT SYNC

`hackathon-sealedbid` is locked at `@magicblock-labs/ephemeral-rollups-sdk@^0.8.5` with a simulated nacl-box TEE seal. `sealedbid-on-chain` is on `^0.11.1` with the real MagicBlock TEE attestation flow. **Why:** the April 2026 devnet TEE migration introduced two contract skews against 0.8.5 (`/quote` 32→64 byte challenge, `hclVarDataSha256`→`reportDataSha256` field rename, both surfaced in `PER-INTEGRATION-LOG.md`). 0.11.1 is the floor that fixes both. v1 doesn't touch the real TEE so it doesn't care, and stage reliability is higher with the simulated path. **Do not run `npm update` in either folder thinking you're harmonizing dependencies — you'd break v1's stage demo or regress v2's attestation path.** The drift is the point.

### `anchor-cli 1.0.1` silently rewrites `declare_id!` — verify after every fresh build

**The footgun:** on the first build of a fresh `target/`, `anchor-cli 1.0.1` auto-generates a random keypair at `target/deploy/<name>-keypair.json` AND rewrites `declare_id!()` in `programs/<name>/src/lib.rs` AND `[programs.devnet]` in `Anchor.toml` to match it. If you `cp wallets/program.json target/deploy/<name>-keypair.json` AFTER the first build, the keypair file is now canonical but the bytecode and source are not. The deployed `.so` will fail every tx with anchor error 4100 `DeclaredProgramIdMismatch`.

**The rule:** after the first build, always grep `declare_id!` in `lib.rs` AND the `[programs.*]` block in `Anchor.toml`, and verify both still match the canonical program ID. If either has drifted, revert by hand, then `anchor build` again before deploying.

Even better: do the keypair `cp` BEFORE the first build, so the auto-rewrite locks in the right ID from the start.

**Symptoms when it bites you:**
- `anchor deploy` succeeds, but the `.so` byte-search shows the *wrong* program ID embedded.
- Every client tx returns `Error: AnchorError occurred. Error Code: DeclaredProgramIdMismatch. Error Number: 4100.`
- The deployed program account address (the canonical one in `wallets/program.json`) does NOT match the `declare_id!` in the source.

Surfaced in `PER-INTEGRATION-LOG.md` entry (l). Logged here because the failure mode is silent on build, only surfaces at runtime, and the diagnostic chain (4100 → byte-search the .so → spot the wrong ID → grep source) is non-obvious without the prior context.

### `init` + `#[delegate]` cannot live in the same instruction

Solana's runtime forbids one top-level instruction from both modifying an account's data AND changing its owner. Anchor's `init` does the data-write half; the SDK's `#[delegate]` macro tries to CPI into the delegation program in the same ix and change ownership. Result: `Error: instruction modified data of an account it does not own`.

**The fix:** split. `post_job` (or whatever creates the PDA) should be init-only. A separate `delegate_<thing>` instruction takes the already-initialized PDA as `AccountInfo<'info>` (not `Account<T>`, since ownership is about to change) and runs the delegation CPI.

This is the canonical pattern in `magicblock-engine-examples`. Don't try to be clever and combine them — every Solana program that delegates accounts to a PER session ships init and delegate as separate ixes for this reason.

Surfaced in `PER-INTEGRATION-LOG.md` entry (m).

### ER transactions are gasless — do NOT mark the signer `mut`

**Canonical answer from MagicBlock team, 2026-04-27:**

> "There is no fee payer on the ER in the regular case (gasless), unless you want to undelegate using a payer, then include the magic fee vault in undelegation. Don't forget to remove mut on signer."

ER writes are gasless. There is no "fee payer" on regular in-ER instructions. The PER pre-flight error `transaction verification error: This account may not be used to pay transaction fees` is **not** a registration/escrow problem. It's caused by marking the signer `#[account(mut)]` in the Anchor Accounts struct, which signals "this signer pays fees" to PER, which then runs the fee-payer eligibility check and rejects.

**The rule:**

- For any instruction that runs **inside the ER** (delegated accounts only): the signer should be **`Signer<'info>` only** — NOT `#[account(mut)]`. Mutable PDAs (the actual auction state) stay `mut`. The signer just signs.
- For any instruction that **commits state back to L1** (undelegation), include a fee payer + the magic fee vault per the SDK's undelegation helpers. That's the only path where a fee-payer concept exists.

**Symptoms when you mark the signer `mut` accidentally:**

- All read paths still work (`account.fetch`, `getSlot`).
- Every write returns `transaction verification error: This account may not be used to pay transaction fees` at PER pre-flight (program never runs, no on-chain logs).
- Affects BOTH TEE-PER (`devnet-tee.magicblock.app`) and non-TEE PER (`devnet.magicblock.app`) identically — this is a runtime check, not endpoint-specific.

**Diagnostic shortcut:** if PER rejects writes with the fee-payer error AND reads work fine, grep your Accounts structs for `#[account(mut, signer)]` or `#[account(mut)] pub <name>: Signer<'info>` — that combo is the bug.

Surfaced in `PER-INTEGRATION-LOG.md` entries (o) and (p).

### "Remove mut on signer" needs Anchor's init pattern adapted

The MagicBlock answer (`don't mark signer mut`) is correct for in-ER writes, but **Anchor's `init` constraint requires its `payer` to be mutable** (the payer funds the rent). So you can't just delete `mut` from a `provider: Signer<'info>` if that same provider is also the payer of a freshly-`init`ed PDA — the program won't compile.

**Two canonical patterns from `magicblock-engine-examples/ephemeral-account-chats/`:**

1. **`append_message` style — pre-create on L1, then ER-only writes.** Three instructions: `init_bid` (on base layer, payer=provider, payer is `mut`), `delegate_bid` (flips to PER), then `submit_bid` (in PER, signer is NOT `mut`). Bigger refactor; each step is well-trodden.
2. **`create_conversation` style — `#[ephemeral_accounts]` macro.** Single instruction creates the Bid directly in PER. Macro auto-injects the vault + magic_program accounts, handles the gasless rent path, and lets you keep the signer non-mutable. One ix per write. Slightly more magic but the canonical "right" pattern for new state inside PER.

Pick (2) for new programs unless you have a strong reason to do (1) (e.g. base-layer-discoverable PDAs are part of your indexer story). Surfaced in `PER-INTEGRATION-LOG.md` entry (q).

### `#[ephemeral_accounts]` macro siphons rent from a sponsor — pre-fund the parent PDA

When you use the `#[ephemeral_accounts]` macro to allocate a new account inside PER (`create_conversation` style), the macro pulls rent from a **sponsor** account marked in your Accounts struct, NOT from the gasless signer. If the sponsor is a freshly-created PDA holding only rent-exempt-minimum, it has nothing to spare and the macro fails.

**The pattern that works (verified for SealedBid v2 Bids):**

1. `post_job` — creates the Job PDA on L1 with rent-exempt minimum. Add a `sponsor` marker on the Job in the Accounts struct.
2. **Pre-fund the Job with ~0.01 SOL** as a separate `SystemProgram.transfer` between `post_job` and `delegate_job`. This gives the sponsor headroom for future ER allocations.
3. `delegate_job` — moves Job (now over-funded) to PER.
4. `submit_bid` — `#[ephemeral_accounts]` macro creates the Bid in PER, siphoning rent from the sponsor (Job).

The exact pre-fund amount depends on how many Bids you expect per Job. ~0.01 SOL covers a few hundred Bids at devnet rent rates. Document the cap in your auction logic so you don't run a sponsor dry mid-auction.

Surfaced in `PER-INTEGRATION-LOG.md` entry (r).

### Escrow PDAs (`createTopUpEscrowInstruction`) are for UNDELEGATION fee payment, not routine ER writes

We wasted hours on this. To clarify:

- **Routine ER writes (in-PER, gasless):** use the `#[ephemeral_accounts]` macro + sponsor pattern above. No escrow involved.
- **Undelegation (committing state back to L1 with a fee payer):** use `createTopUpEscrowInstruction` to fund an escrow PDA at `escrowPdaFromEscrowAuthority(authority, index)`, then include the magic fee vault in the undelegation ix. This is the only path where `escrowPdaFromEscrowAuthority` matters.

If your symptom is `transaction verification error: This account may not be used to pay transaction fees` on a regular ER write, **escrow funding will not help**. The fix is the gasless pattern (drop `mut` on signer + use `#[ephemeral_accounts]` for new state).

Surfaced in `PER-INTEGRATION-LOG.md` entry (o)→(r).

### Non-TEE PER cannot host writes for accounts delegated to the TEE validator

Once a Solana account is delegated to the TEE validator (`MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`), the non-TEE ER endpoint (`https://devnet.magicblock.app`) can **read** the account (read-side RPC routing fans out across validators) but **cannot host writes**. Writes return `Transaction loads a writable account that cannot be written`.

This is architectural, not a bug. The validator that hosts a delegated account's mutable state is fixed by the delegation. Don't waste time fighting it. If you need writes from non-TEE PER, you'd need a separate program with its own delegation chain to a non-TEE validator.

Surfaced in `PER-INTEGRATION-LOG.md` entry (r).

### `anchor deploy` does NOT auto-extend ProgramData — extend manually before upgrading bigger bytecode

When the new `.so` is larger than the current ProgramData allocation, `anchor deploy` fails with `ProgramData account not large enough`. Anchor doesn't extend automatically. You have to extend before deploying:

```
solana program extend <PROGRAM_ID> <ADDITIONAL_BYTES>
```

Pad generously (e.g. 100 KB headroom) so iterative builds don't hit the same error. Cost is the rent for the new bytes (cheap on devnet, real on mainnet).

**Symptom:** mid-deploy bytecode upload completes (chunks stream in), then the final atomic upgrade tx fails with `ProgramData account not large enough`. The uploaded bytecode is parked in a buffer account and your SOL is stuck there.

### Recovering from stuck deploy buffers

When `anchor deploy` fails after uploading bytecode (e.g. ProgramData-too-small, network drop, version skew), the bytecode is left in a buffer account and your SOL is locked there. Reclaim it:

```
solana program close <BUFFER_ACCOUNT_ID> --recipient $(solana address)
```

The buffer ID is printed in the failed deploy output. Closing returns the rent to your wallet. Always do this before any retry — otherwise multiple stuck buffers compound and you bleed SOL silently.

Surfaced in `PER-INTEGRATION-LOG.md` entry (q): 2.18 SOL was stuck in `6p9kGNJPSc7xf1Q5h8eAQjuCcvUwY4cPDFr7zaZznEkK` after a failed upgrade. One `solana program close` returned all of it.

### Private SPL transfer is async — `schedulePrivateTransferIx` schedules, Hydra crank delivers

`transferSpl(visibility: 'private', validator: <TEE_VALIDATOR>)` returns a single bundled instruction (deposit + delegate-shuttle + schedule). The on-chain tx that lands is the **schedule** — it commits funds to the per-mint vault and queues the transfer. Final delivery to the recipient's ATA happens async, when the TEE validator's Hydra crank processes the queue.

**This is a feature, not a bug.** The async finalization is what enables privacy: the validator can batch multiple senders' transfers, randomize ordering, and add timing delay so external observers can't link a sender's deposit to a recipient's credit.

**Diagnostic chart:**

| Symptom | Means |
|---|---|
| Schedule tx lands on devnet, valid sig | ✅ client-side path works |
| Sender's USDC ATA debited by amount | ✅ deposit + delegate-shuttle worked |
| Per-mint vault PDA holds your funds (pooled with other senders) | ✅ in-flight, awaiting crank |
| Recipient's ATA still 0 after minutes | ⚠️ validator hasn't processed yet — wait, do not retry |
| `ensureTransferQueueCrankIx` fails `InvalidAccountOwner` | ✅ expected — only the TEE validator can advance a delegated queue |

**What you cannot do client-side:** advance the queue. The queue is delegated to the TEE validator, so external cranks return `InvalidAccountOwner`. Don't waste tx fees trying.

**Devnet Hydra crank cadence is unspecified and slow.** In our test runs, ≥5 min with no delivery as of 2026-04-27 (open Discord question to MagicBlock for canonical cadence + status query). Mainnet cadence may be faster but undocumented. For demos that need synchronous-looking settlement, fall back to `live-sol` mode (plain L1 SystemProgram.transfer).

**Pitch framing for the async settlement:** this matches T+1 / T+2 settlement in traditional finance. "Private USDC payments are scheduled on-chain in the TEE PER, async-finalized by the validator" is the institutionally honest story. Don't promise retail-style "instant."

Surfaced in `PER-INTEGRATION-LOG.md` entry (u).

### `commit_and_undelegate` requires `AccountInfo`, not `Account<T>` (exit-time serialize fight)

Any account that you pass to `commit_and_undelegate_accounts(...)` from inside an in-PER ix must be declared as `AccountInfo<'info>` in your `#[derive(Accounts)]`, not as a typed `Account<'info, T>`. Otherwise Anchor's exit-time `T::try_serialize` runs AFTER the magic program has staged the ownership flip and the tx fails with:

```
Error processing Instruction 0: instruction modified data of an account it does not own.
```

The error is misleading — the issue isn't that you modified data you don't own, it's that Anchor tried to write to an account whose ownership the magic program has already begun rotating. The fix mirrors the `delegate_job` pattern:

1. Declare the account as `AccountInfo<'info>` with `#[account(mut)]` (no `Account<T>`, no `seeds` constraint that derefs the data buffer).
2. In the handler: `try_deserialize` the account manually, mutate the local struct, and `try_serialize` it back BEFORE the `commit_and_undelegate_accounts(...)` CPI. After the CPI returns, do not touch the account again.

Surfaced in `PER-INTEGRATION-LOG.md` entry (w).

### `commit_and_undelegate` is async — poll `getAccountInfo(pda).owner` for completion

The `commit_and_undelegate_accounts(...)` CPI inside a PER ix returns immediately. The actual ownership flip on L1 (delegation_program → your program) happens after the magic program processes the scheduled intent on the next slot or two. Devnet typically completes within 3-5s.

To detect completion from a client (e.g. before calling a follow-up L1 ix that requires the account back in your program's ownership), poll `getAccountInfo(pda).owner` and wait for it to equal your program's pubkey. ~750ms cadence + ~60s timeout is fine for devnet.

Surfaced in `PER-INTEGRATION-LOG.md` entry (w).

### Trustless escrow on a PDA: `init` then `system_program::transfer` (same ix)

To make a PDA hold escrow lamports beyond rent-exempt minimum at creation time:

1. `init` the PDA via Anchor's normal `#[account(init, payer = ..., space = ...)]` — sets rent-exempt minimum.
2. In the handler body, do `system_program::transfer(CpiContext::new(system_program, Transfer { from: payer, to: pda }, deposit))`.

This works because right after `init`, the PDA is still effectively "system-controlled" lamport-wise (Anchor's `init` doesn't move ownership in a way that prevents an inbound system transfer). The transfer succeeds, and the PDA now holds `rent + deposit` lamports. From this point onward the program controls every lamport above the rent-exempt minimum — clients cannot move them without a program-blessed ix.

Combine with `#[account(close = recipient)]` on a later ix to refund the residual: Anchor's `close` zeroes the data, reassigns to System program, and transfers the FULL lamport balance (including escrow remainder) to the recipient. **One atomic ix can pay a winner from the escrow AND close the PDA, refunding the unused portion.** This is the simplest pattern for auction-style escrow on Solana.

**Compose-with-private-SPL-payouts variant:** when the actual payout currency is an SPL token (e.g. USDC) but you want a SOL backstop for trustless rent reclaim, run two L1 ixs in the settlement bundle. First a refund-only variant of your settle ix (program-enforced rent + escrow refund, no payout to winner). Then the SDK's `transferSpl(visibility:'private', validator:TEE)` for the actual payout. Both legs reference the on-chain winner from the auction state, so the coordinator can't reroute the payout without contradicting the on-chain outcome. Surfaced in PER-INTEGRATION-LOG entry (x).

Surfaced in `PER-INTEGRATION-LOG.md` entry (w).

### Ephemeral PDA rent flows sponsor → magic vault, not sponsor → child

When `#[ephemeral_accounts]` creates a child account in PER, the rent is debited from the sponsor and credited to `EPHEMERAL_VAULT_ID`, NOT into the ephemeral child itself. The child holds zero excess lamports; only the data buffer matters.

To recover that rent before commit-and-undelegate, call `EphemeralAccount::new(sponsor, child, vault).with_signer_seeds(sponsor_seeds).close()` for each ephemeral child. The magic program will refund the rent from the vault back to the sponsor's PER lamports. If you skip this, the rent stays in the vault permanently — a per-child cost that compounds across auctions.

For low-volume auctions this rent (~80k lamports per Bid PDA on devnet) is acceptable. For high-volume systems, integrate the close into your auction-close ix.

Surfaced in `PER-INTEGRATION-LOG.md` entry (w).

### Level B reference deploy (Solana devnet, 2026-04-26)

The on-chain Anchor program for SealedBid v2 Level B is deployed and live. Treat these as canonical for any TS client work and as the recovery target if anything drifts.

| Field | Value |
|---|---|
| Program ID | `5JaacAzrnjCwsigZxxHBDkiNuT2SQFG8xxMKVgyy629Q` |
| ProgramData account | `DcnXmejrvEwzzU9cL6ifY21vbtF6LXQtPs56uToWJfWQ` |
| Upgrade authority | `5f6bQSwvd22RyuSEnoqtLYpmE1nFBnfmHVGUhRhHPEwK` (deployer wallet, `~/.config/solana/id.json`) |
| On-chain IDL metadata | `CNwcF25m5jMzMrWz2KyxvtmvD2KHZ4kHDhxzS1Fn6skE` (published automatically by `anchor deploy`) |
| Deployer keypair | `~/.config/solana/id.json` (machine-local, NOT in repo) |
| Program keypair | `sealedbid-on-chain/wallets/program.json` (matches `declare_id!` and the `5Jaac…` ID) |
| Cluster | Solana devnet (`https://api.devnet.solana.com`) |
| Explorer | `https://explorer.solana.com/address/5JaacAzrnjCwsigZxxHBDkiNuT2SQFG8xxMKVgyy629Q?cluster=devnet` |

**Working dep set that produced this deploy** (do not drift): `anchor-lang = "0.32.1"` (caret) with lockfile pin via `cargo update -p anchor-lang@1.0.1 --precise 0.32.1`, `ephemeral-rollups-sdk = { version = "0.11.2", features = ["anchor"] }`, `anchor-cli 1.0.1`, `solana-cli 3.1.14`, `rustc 1.95.0`. See `PER-INTEGRATION-LOG.md` entries (i)–(k) for the full path, including the `#[delegate]` macro workaround (PostJobArgs.job_nonce stored as `[u8; 8]` so seeds use `args.job_nonce.as_ref()` with no method call).

**Backup discipline:** Loss of `wallets/program.json` OR the deployer keypair at `~/.config/solana/id.json` permanently removes the ability to upgrade the program. The deployed bytecode keeps running, but any future fix would need a fresh program ID. Back up both before any environment migration.

---

## 16. Where to update this file

When Claude Code (or anyone) discovers a new gotcha during v2 development:
1. Add it to section 14 with date, what happened, resolution, lesson.
2. If it changes a recommended SDK version or endpoint, update sections 1-3 too.
3. If it's a build-time tradeoff, add it to section 15.
4. Never delete entries. Future-you will need them.

