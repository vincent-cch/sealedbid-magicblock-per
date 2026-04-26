# SealedBid v2 — on-chain sealed-bid auction (Level B + Level C steps 1 & 3b — trustless escrow + private USDC)

Sealed-bid compute auction house for AI agents. Anchor program on Solana devnet, bid execution AND winner determination inside a MagicBlock TEE-protected Private Ephemeral Rollup (PER), and **program-enforced escrow** that signs the payout, refunds the requester, and closes the Job PDA in one atomic on-chain ix.

This is the Level B + Level C steps 1 & 3b progression of the v1 hackathon prototype:

- **Auction logic** is a real on-chain Anchor program (`5JaacAzrnj…`) — not a Node process.
- **Bids** run gaslessly inside the MagicBlock TEE-protected PER.
- **Winner determination** happens on-chain in `close_auction` (Level C step 3a). The off-chain coordinator never picks the winner.
- **Settlement** is program-signed: `settle_auction` pays the winner from a SOL escrow held inside the Job PDA and refunds the unused remainder to the requester (Level C step 3b). Or, in private USDC mode, `settle_auction_refund` reclaims the SOL escrow and the SDK's `transferSpl(visibility:'private', validator:TEE)` schedules an async-finalized USDC transfer (Level C step 1).
- **No off-chain custody decisions.** The coordinator orchestrates; the program enforces.

## Architecture

```
                     base devnet (Solana)
                ┌──────────────────────────────────┐
   requester ──▶│  post_job                        │   Job PDA created
                │   + system_program::transfer     │   max_bid_deposit lamports
                │     (escrow into Job PDA)        │   moved into the Job PDA
                │  delegate_job                    │   Job PDA → owned by
                └────────┬─────────────────────────┘   delegation program
                         │
                         ▼
              MagicBlock TEE-PER (Intel TDX)
              ┌──────────────────────────────────┐
   provider ─▶│  submit_bid                      │   Bid PDA created
   (×N)       │  (gasless, via JWT)              │   atomically inside the
              │  ephemeral_accounts macro        │   ephemeral session
              │  allocates Bid                   │
              └────────┬─────────────────────────┘
                       │
                       ▼ (deadline elapses)
              ┌──────────────────────────────────┐
   requester ─▶│  close_auction                  │   Bid PDAs in remaining_accounts.
              │  (gasless, signer-no-mut)        │   Program inspects all bids,
              │  + commit_and_undelegate(Job)    │   picks the lowest, writes
              └────────┬─────────────────────────┘   Job.winner + Job.winning_amount.
                       │                              CPI schedules undelegate; magic
                       │                              program processes async (~3-5s).
                       ▼ (Job back on L1, owned by program)
                base devnet (Solana)
              ┌──────────────────────────────────┐
   live-sol  ─▶│ settle_auction                  │   Program transfers winning_amount
              │   (program-signed payout)        │   from Job's escrow → winner.
              │   + close = requester            │   Anchor close=requester refunds
              │                                  │   rent + unused escrow → requester.
              │                                  │   Job PDA closed in same tx.
              └──────────────────────────────────┘   (Level C step 3b — trustless)

              ┌──────────────────────────────────┐
   live-usdc ▶│ settle_auction_refund            │   Refunds 100% of SOL escrow
              │   + close = requester            │   to requester. Job PDA closed.
              │                                  │
              │ transferSpl(visibility:'private',│   Schedules async USDC transfer
              │   validator: TEE)                │   from requester ATA → winner ATA
              │                                  │   via the TEE shuttle. Hydra crank
              │                                  │   delivers async (knowledge pack §15).
              └──────────────────────────────────┘   (Level C step 1)
```

**OnchainAuctionCoordinator** (`auction/onchain-coordinator.ts`) drives the whole flow. Per auction it emits: `job-posted`, `job-delegated`, `bid-submitted` (×N), `auction-closed`, `job-undelegated`, `settled`. The WebSocket server (`server.ts`) translates those into the v1-compat event names the existing React UI consumes.

## Settlement modes

All three modes share the trustless SOL escrow flow up through `close_auction` + commit-and-undelegate. They differ only in what fires on L1 once the Job is back.

| Mode | Flag | Behavior | Avg cost / auction | Notes |
|---|---|---|---|---|
| **Trustless SOL** | `--sol-settle` | `settle_auction` pays SOL → winner from escrow, closes Job PDA, refunds rest to requester | ~507k lamports = **0.000507 SOL** | Synchronous. **~50× cheaper** per auction than the pre-3b version that stranded escrow in retired Job PDAs. Best for live demos. |
| **Private USDC** | (default) `--live-usdc-tee` | `settle_auction_refund` (full SOL escrow → requester) + `transferSpl(private, TEE)` for async USDC payout | ~2.37M lamports SOL + bid amount in µUSDC | Schedule tx lands immediately; Hydra crank delivers async (devnet cadence unspecified per knowledge pack §15). Best for institutional pitch — privacy + async finalization is a feature, not a bug. |
| **Simulated** | `--simulated` | No settle ix; emits sentinel sig. Job stays delegated, escrow stranded. | ~5.7M lamports stranded | Stress testing only — never use for real demos because the SOL leak compounds. |

The CLI picks the mode via flags (above). The **WebSocket server** (`server.ts`) picks via the `SETTLEMENT_MODE` env var:

```bash
SETTLEMENT_MODE=live-sol     npm run server   # synchronous SOL payout
SETTLEMENT_MODE=live-usdc-tee npm run server  # default — needs USDC in requester wallet
SETTLEMENT_MODE=simulated    npm run server   # no settle ix
```

Default is `live-usdc-tee`, which assumes the requester wallet holds USDC for the `transferSpl` bundle. **Deployments without USDC funding must set `SETTLEMENT_MODE=live-sol`** or the settle step throws every auction. Unknown values fall back to `live-usdc-tee` with a warning.

For pm2 (e.g. on the VPS) update the env and restart with `--update-env`:

```bash
pm2 set sealedbid-server:SETTLEMENT_MODE live-sol
pm2 restart sealedbid-server --update-env
# Or, declared in ecosystem.config.cjs under env: { SETTLEMENT_MODE: 'live-sol' }, then pm2 reload.
```

## Quickstart — three commands

```bash
# 1. Install deps (only needed once)
npm install

# 2. Run an auction series in the CLI (no UI needed)
npm run demo                     # 3 auctions, default = live-usdc-tee
npm run demo -- --sol-settle     # synchronous SOL payout via settle_auction
npm run demo -- --simulated      # skip settlement, fastest for stress testing
npm run demo -- --count 5        # custom count
npm run demo -- --task echo      # pin task type

# 3. Or boot the WebSocket server + UI for the visual demo
npm run server                   # terminal 1: ws://localhost:8787
npm run ui                       # terminal 2: http://localhost:5173
```

The server only runs auctions while at least one browser is connected. Open the UI in any browser pointed at `http://localhost:5173` and the auction loop kicks off.

## Two UI views

The same WebSocket feed drives two completely separate visualizations:

| Route | Aesthetic | Purpose |
|---|---|---|
| `http://localhost:5173/` | Institutional dashboard (zinc/fuchsia, dense info layout, mainnet sim on the right pane for throughput contrast) | BD pitch / hero recording. Shows the audit story: tx receipts, settlement links, balance reconciliation. |
| `http://localhost:5173/#/arcade` | Pixel-art arcade (Press Start 2P font, neon palette, ship sprites for each provider, hex vault, projectile + coin animations) | Hackathon clip / social-shareable. Same data, different vibe. |

Routing is hash-based (no `react-router` dep) — `/` renders `<Dashboard />`, anything else with `#/arcade` renders `<Arcade />`. The dashboard's left pane stacks the last 8 cleared auctions with positional opacity tiers (100% → 70% → 40%), so the throughput delta vs the right-side mainnet sim is obvious at a glance.

### WebSocket endpoint config

Both views read their WS URL from the `VITE_WS_URL` env var at **build time** (Vite inlines `VITE_*` constants into the bundle). Default is `ws://localhost:8787` so `npm run dev` Just Works against `npm run server`.

For the public VPS deploy, point at the reverse-proxied wss endpoint before building the static bundle:

```bash
# Local dev — no env needed.
cd ui && npm run dev

# Production build (e.g. for VPS at sealedbid.liquidated.xyz)
cd ui
echo 'VITE_WS_URL=wss://sealedbid.liquidated.xyz/ws' > .env.production
npm run build   # writes ui/dist/ with the URL inlined
```

A template lives at `ui/.env.example`. **Don't edit `useAuctionFeed.ts` or `Arcade.tsx` to swap the URL** — that pattern caused dev↔VPS drift and is no longer necessary.

## Stress test

The CLI runner has a `--stress N` mode for parallel-wave auctions. Best config for devnet's public RPC (rate limit caps higher concurrencies):

```bash
npm run demo -- --stress 50 --sol-settle --stress-concurrent 2 --stress-stagger-ms 500
```

Verified results (entry y in `PER-INTEGRATION-LOG.md`):

| | Result |
|---|---|
| Cleared | 50/50 (100% pass rate) |
| Wall clock | 181.83 s |
| p50 / p95 / p99 latency | 6997 ms / 7628 ms / 13048 ms |
| Throughput | 0.27 auctions / sec |
| Total SOL burn | 0.025379 SOL |
| Avg per-auction SOL | 507,586 lamports (matches the trustless reconciliation target) |
| Winner distribution | speedy 17 · accurate 16 · budget 17 |

The bottleneck is devnet public RPC; switching to a private RPC (Helius / Triton) would unlock 5-10 concurrent auctions cleanly. Add `--quiet` to suppress per-auction lines for clean BD-video footage:

```bash
npm run demo -- --stress 50 --sol-settle --stress-concurrent 2 --stress-stagger-ms 500 --quiet
```

## Wallets

Pre-generated keypairs live in `wallets/`:

| Role | File | Required SOL on devnet |
|---|---|---|
| Requester | `wallets/requester.json` | ≥ 0.05 SOL (server enforces; covers ~30 sequential auctions or ~5 stress runs) |
| Providers ×3 | `wallets/provider-{1,2,3}.json` | 0 SOL — providers bid gaslessly inside PER. Auto-bootstrapped to ~0.002 SOL per wallet for L1 rent on first run. |
| Program upgrade authority | `~/.config/solana/id.json` | only for `anchor deploy` |
| Program ID keypair | `wallets/program.json` | n/a — identifies `5JaacAzrnj…` only |

Top up the requester via https://faucet.solana.com (CLI airdrop is rate-limited 429 most days — see `PER-INTEGRATION-LOG.md` for the gory history).

## On-chain references

| Object | Address | Explorer |
|---|---|---|
| Program | `5JaacAzrnjCwsigZxxHBDkiNuT2SQFG8xxMKVgyy629Q` | https://explorer.solana.com/address/5JaacAzrnjCwsigZxxHBDkiNuT2SQFG8xxMKVgyy629Q?cluster=devnet |
| ProgramData | `DcnXmejrvEwzzU9cL6ifY21vbtF6LXQtPs56uToWJfWQ` | https://explorer.solana.com/address/DcnXmejrvEwzzU9cL6ifY21vbtF6LXQtPs56uToWJfWQ?cluster=devnet |
| IDL metadata | `CNwcF25m5jMzMrWz2KyxvtmvD2KHZ4kHDhxzS1Fn6skE` | https://explorer.solana.com/address/CNwcF25m5jMzMrWz2KyxvtmvD2KHZ4kHDhxzS1Fn6skE?cluster=devnet |
| Delegation program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` | (MagicBlock canonical, same on devnet+mainnet) |
| Magic program | `Magic11111111111111111111111111111111111111` | (commit_and_undelegate target) |
| TEE validator | `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` | (devnet) |
| Devnet USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | (Circle faucet target) |

Sample auction tx receipts from a stress run on 2026-04-26:

- post_job: https://explorer.solana.com/tx/42kuuYncr4eXiAnhggTKd8QQrKeSQR4j3tLpqMKTHbo6uTCBZnZgcGWZMNiQDZ76RLMViMYYs5SMJjsduEmshDUT?cluster=devnet
- delegate_job: https://explorer.solana.com/tx/5KmaLr1e5VGw3KKKaFAMPX7CmwzyRiCtAY2S2iSgCULor2hJxTSmmDWdQVeGiaYYfG8xgmFAGVEG6Z8LZ5zKpyPU?cluster=devnet
- settle_auction (live-sol): https://explorer.solana.com/tx/3Xd4wdE4553FgE5hgxNvRG22KiPSFHvQm5yAc9aYB9ERxfpR4WEKLEa7vjqJcYoonfCbLvJBth3rBaHxNPk8NWFs?cluster=devnet
- settle_auction_refund + USDC schedule (live-usdc-tee): refund [`5HiWTsXG7nwP…`](https://explorer.solana.com/tx/5HiWTsXG7nwP9TyWMCp3w7zGqV7T9fbFRGg4fKfTSDhHURXaWmaSh8Y25qqPoNMtKqJp3iiv2kSiX8vNYH6Lgftz?cluster=devnet) · USDC [`5GaoQzG6aCqM…`](https://explorer.solana.com/tx/5GaoQzG6aCqMmMpxKEgn5LTnUt2vmcacrZwatpjHKwWAawn3fyGW5eEQ96ByARwErEbX4xiBudnZz6An3ai8pUM7?cluster=devnet)

`anchor idl fetch 5JaacAzrnj… --provider.cluster devnet` retrieves the live on-chain IDL.

## File map

```
sealedbid-on-chain/
├── programs/sealedbid/src/lib.rs        # Anchor program — post_job, submit_bid, delegate_job,
│                                        # close_auction (PER), settle_auction (L1 SOL),
│                                        # settle_auction_refund (L1 SOL refund for USDC mode)
├── auction/
│   ├── onchain-coordinator.ts           # drives the full on-chain auction; 3 settlement modes
│   ├── coordinator.ts                   # v1 simulated coordinator (kept for reference)
│   └── seal.ts, settle.ts               # v1 seal + settlement (legacy paths)
├── clients/
│   ├── post-job.ts                      # standalone tx clients (one-shot, for debugging)
│   ├── delegate-job.ts
│   ├── submit-bid.ts                    # TEE path (canonical)
│   └── submit-bid-nontee.ts             # non-TEE retry (failed; see entry r)
├── server.ts                            # WebSocket server (port 8787)
├── demo-run.ts                          # CLI runner — sequential + --stress mode
├── ui/
│   ├── src/components/
│   │   ├── LeftPane.tsx                 # PER stacked-history panel (8 cards, opacity tiers)
│   │   ├── RightPane.tsx                # Mainnet simulation (single-flight, untouched from v1)
│   │   ├── AuctionCard.tsx              # shared card chrome
│   │   └── Arcade.tsx                   # /#/arcade pixel-art view
│   └── src/hooks/useAuctionFeed.ts      # dashboard WS subscription
├── wallets/                             # pre-generated keypairs
├── scripts/
│   ├── bootstrap-providers.ts           # idempotent SOL + USDC ATA seeding
│   ├── check-per.ts                     # TEE attestation health check
│   └── ...
├── PER-INTEGRATION-LOG.md               # full debug log of every PER bug we hit
└── SCOPE-LEVEL-B.md                     # original Level B spec
```

## Reference docs (the gold for other PER builders)

- **`PER-INTEGRATION-LOG.md`** — running log of every gnarly PER-side issue we hit, with the canonical fix for each. Read this before debugging anything PER-related. Most useful entries:
    - (j) build-time `declare_id!` foot-gun — anchor-cli rewrites your source
    - (q)+(r) `#[ephemeral_accounts]` + sponsor pre-fund pattern that finally made `submit_bid` work
    - (u) Private SPL transfer is async — Hydra crank cadence on devnet
    - (v) Level C step 3a — winner determined on-chain
    - **(w) Level C step 3b — trustless escrow + program-enforced payout + Job PDA reclaim**
    - **(x) USDC settlement re-integrated on top of trustless escrow**
    - **(y) Stress mode — 50 parallel auctions, 100% pass rate**
    - (z) Arcade view (pixel-art demo)
- **`MAGICBLOCK-PER-KNOWLEDGE-PACK.md`** — broader PER notes (TEE attestation, JWT auth, validator pinning, gotchas around `commit_and_undelegate` vs Anchor exit-time serialize, etc).
- **`MILESTONE-LEVEL-B.md`** — fully on-chain auction with real SOL settlement.
- **`MILESTONE-LEVEL-C-1.md`** — private USDC settlement (re-integrated on top of C-3b in entry x).
- **`MILESTONE-LEVEL-C-3a.md`** — on-chain winner determination via close_auction.
- **`MILESTONE-LEVEL-C-3b.md`** — program-enforced escrow + atomic payout + rent reclaim.
- **`SCOPE-LEVEL-B.md`** — the original Level B milestone spec.
- **`SPEC.md`** — original v1 product spec (still mostly accurate for the auction model).

## Out of scope / future work

- **Bid PDA close** in `close_auction` (entry w future improvements). Each ephemeral Bid PDA leaks ~80k lamports into the magic vault. Recoverable via `EphemeralAccount::close()` before the commit-and-undelegate CPI; deferred to keep this PR focused.
- **TEE payload encryption** (Level C step 2). Encrypt bid amounts client-side to the enclave session pubkey for adversarial threat model coverage.
- **Server-side parallel auto-loop.** The `npm run server` auction loop is single-flight today. The CLI `--stress` mode is the parallel runner — UI-side parallelism would need server.ts to adopt the same worker-pool pattern.
- **Private RPC swap.** Devnet public RPC caps stress concurrency at 2. Helius / Triton would unlock 5-10. One env var change (`SOLANA_RPC_URL`).
- **Permission Program integration** for permissioned reads / dynamic add-on rules.

## Known gotchas

- **Anchor-cli 1.0.1 silently rewrites `declare_id!`** during the first build to match `target/deploy/<name>-keypair.json`. If anchor auto-generates a fresh keypair, your source files will be mutated. Always `cp wallets/program.json target/deploy/sealedbid-keypair.json` BEFORE the first build, or run `anchor keys list` and verify against `lib.rs` after every build.
- **`@coral-xyz/anchor 0.32.1` (current npm latest) doesn't read IDL accounts published by `anchor-cli 1.0.1`.** The TS client shells out to the rust CLI (`anchor idl fetch`) to fetch the IDL. Revisit when `@coral-xyz/anchor 1.x` ships on npm.
- **Provider's regular wallet does NOT pay tx fees in PER.** `mut` on a Signer triggers PER's fee-payer eligibility check — drop it. New accounts created in PER use the `#[ephemeral_accounts]` macro pattern with a delegated sponsor PDA, NOT `init` + `system_program::create_account`.
- **TEE-only writes.** Our `delegate_job` pins the validator to the TEE (`MTEWGu…`). Writes via the non-TEE generic endpoint (`https://devnet.magicblock.app`) fail with "writable account that cannot be written"; use `https://devnet-tee.magicblock.app`. Reads work either way.
- **`commit_and_undelegate` requires `AccountInfo`, not `Account<T>`** in the Accounts struct, otherwise Anchor's exit-time serialize fights the magic program's mid-tx ownership staging and the tx fails with `instruction modified data of an account it does not own`. See entry (w).
- **Devnet public RPC caps stress concurrency at ~2.** Use a private RPC for higher throughput. See entry (y).

## Hackathon submission

- **Project:** SealedBid v2 — sealed-bid compute auction with trustless escrow + private USDC settlement on Solana.
- **Built solo over a weekend** (Apr 25-27, 2026). One developer, AI-assisted.
- **What this is for the hackathon:** a working reference implementation of the canonical MagicBlock PER patterns on Solana devnet — `#[ephemeral_accounts]` sponsor pattern, gasless ER writes, on-chain `close_auction` from PER, `commit_and_undelegate` + L1 settle round-trip, private USDC via TEE shuttle. Plus `PER-INTEGRATION-LOG.md` — a 1500-line footgun log other PER builders can mine for the canonical fix to every gnarly issue we hit.
- **Program ID:** `5JaacAzrnjCwsigZxxHBDkiNuT2SQFG8xxMKVgyy629Q` (Solana devnet, in-place upgraded across all milestones).
- **Demo recording:** _to be added post-record_ — captures `--stress 50 --sol-settle` (50/50 in 3 minutes, 0.025 SOL total) plus the `/#/arcade` pixel-art view.
- **Reproducible from this repo:** `npm install && npm run demo -- --sol-settle` is enough to spin up a live auction against the deployed program.
