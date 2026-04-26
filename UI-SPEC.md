# UI Spec for SealedBid Demo

This is what Claude Code should build next. Hand this whole file to it.

## Goal

A split-screen browser demo. Left side shows our auction marketplace running live on a MagicBlock PER. Right side shows a (faked) version of the same flow on Solana mainnet for comparison. Audience watches the throughput counter tick up on the left while the right side barely moves.

## Stack (keep it simple)

- Vite + React + TypeScript for the frontend
- Plain Tailwind CSS for styling (CDN OK for hack speed)
- Node + ws (WebSocket) for the backend that streams auction events
- No database. Everything in memory.

## Architecture

```
[server.ts]                                [browser]
runs auctions   ----- WebSocket -----> connects, listens
broadcasts events                       renders cards in real time
```

`server.ts` is a new file at the repo root. It:

1. Imports the existing `AuctionCoordinator`, `ProviderAgent`, `RequesterAgent`
2. Spins up a WebSocket server on port 8787
3. On client connect, starts a continuous auction loop (50-100 staggered auctions)
4. Forwards every coordinator event (`job-posted`, `bids-sealed`, `auction-closed`, `settled`) to all connected clients as JSON

The frontend (`ui/` folder, Vite app) connects to `ws://localhost:8787`, listens, and updates the split-screen view.

## Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  SealedBid                                            [LIVE DEMO]│
├──────────────────────────────────┬──────────────────────────────┤
│  MagicBlock PER (live)           │  Solana Mainnet (simulated)  │
│  ──────────────────              │  ───────────────────         │
│                                  │                              │
│  [auction card] [auction card]   │  [single slow auction card]  │
│  [auction card] [auction card]   │  ⏱ 38s remaining...          │
│  [auction card] [auction card]   │  bids: 0.0023 SOL (public)   │
│  ...                             │                              │
│                                  │                              │
│  ─────────────────────────       │  ─────────────────────       │
│  Cleared: 47                     │  Cleared: 1                  │
│  Throughput: 0.9 auctions/sec    │  0.025 auctions/sec          │
│  Avg cost: 0.000142 SOL          │  Avg cost: 0.0023 SOL        │
│                                  │  (16x more expensive)        │
└──────────────────────────────────┴──────────────────────────────┘
```

## Auction card (the small unit on screen)

Each auction is a card. Lifecycle:

1. **Posted** (gray) - job ID, description, "3 bidders incoming"
2. **Bidding** (yellow border) - shows 3 bid envelopes as scrambled hex strings rotating, like `0x4a8f...e29d`
3. **Cleared** (green) - reveals winner address (truncated), winning bid in lamports, settlement sig
4. **Fades out** after 4s, shifts older cards down

Cards animate in from the top of the column. Newest at top.

## Right side (mainnet sim)

Don't build a second live system. Just one card per ~40s with these visual differences:

- Bids are visible as plain numbers immediately (no encryption)
- A countdown timer ticks down from 40s
- Settlement cost is shown as ~16x higher (0.0023 SOL vs 0.000142 SOL)
- Card stays on screen the whole time, no streaming

This is the visual contrast: left side is a stream, right side is a single slow card.

## Key UI features

1. **Throughput counter** - bottom-left shows total auctions cleared and auctions/sec, updates in real time
2. **Cost ticker** - bottom-left shows running average cost per auction in lamports/SOL
3. **Encrypted bid animation** - while an auction is in the bidding phase, the three bid envelopes show as 16-char hex strings that randomize every 100ms (gives the "encrypted" feel)
4. **Winner reveal** - when cleared, briefly flash green, scramble the envelopes one last time, then show the cleartext winning bid + provider name
5. **Hero auction badge** - if the special hero auction runs, its card has a magenta border and shows "ON-CHAIN SETTLEMENT" plus a clickable explorer link

## What the server must do

1. Add a script `npm run server` that runs `npx tsx server.ts`
2. server.ts creates a coordinator, providers, requester (same as demo-run.ts)
3. Loops continuously: start a new auction every 1s, up to 100 in flight
4. Cycles taskType through `['image-caption', 'text-summarize', 'echo']` so winners rotate
5. Broadcasts a single event every time the coordinator fires anything

Event shape (JSON over WebSocket):

```json
{ "type": "job-posted", "jobId": "...", "description": "...", "taskType": "...", "ts": 1234567890 }
{ "type": "bids-sealed", "jobId": "...", "envelopes": ["0x4a...", "0x9b...", "0xe2..."], "ts": ... }
{ "type": "auction-closed", "jobId": "...", "winner": { "provider": "...", "providerName": "...", "amountLamports": 142000 }, "clearingMs": 5012, "ts": ... }
{ "type": "settled", "jobId": "...", "sig": "...", "mode": "simulated|live", "explorerUrl": null|"...", "ts": ... }
```

Provider name (`speedy`, `accurate`, `budget`) should be added to the broadcasted event so the UI can show readable names instead of pubkeys.

## Provider win rotation fix

In server.ts, cycle `taskType` across auctions. `budget` doesn't support `text-summarize` so when that runs, only `speedy` and `accurate` bid. This naturally rotates winners. Also raise `budget`'s minPrice from 120k to 250k lamports so it's not always the cheapest. Goal: winners distribute roughly 33/33/33 across the three providers across 50 auctions.

## Dev experience

- `npm run server` → starts WebSocket server + auction loop
- `npm run ui` → starts Vite dev server on port 5173 (already in package.json scripts)
- Open http://localhost:5173 in browser → connects automatically to ws://localhost:8787

## Acceptance criteria

- [ ] Open browser, see split-screen layout
- [ ] Left side streams new auction cards every ~1s
- [ ] Each card animates through posted → bidding → cleared
- [ ] Encrypted bid envelopes render as scrambling hex during bidding phase
- [ ] Winner reveals cleartext on close
- [ ] Throughput counter ticks up smoothly
- [ ] Right side shows a single mainnet auction with 40s countdown
- [ ] Cost comparison visible at the bottom of each column
- [ ] Hero auction (when triggered) shows magenta border + explorer link
- [ ] Winners distributed ~33/33/33 across speedy/accurate/budget after 50 auctions

## What NOT to build (cut for time)

- No login or auth
- No backend persistence
- No mobile responsive layout (judges watch on a projector)
- No multi-tab sync
- No fancy charts (just the running counter)
- No dark/light theme toggle (pick dark, ship)

## Style guidance

- Dark background (slate-900 or zinc-900)
- Mono font for hashes and pubkeys
- Use Tailwind defaults, don't customize the theme
- Bid envelope animation = neutral white-on-black scrambling text
- Winner reveal = green-400 flash
- Hero card = magenta-500 border
- Mainnet right column = same colors but everything moves slowly

## Deliverables when done

- New file: `server.ts`
- New folder: `ui/` with a complete Vite React app
- Updated `package.json` with `server` and `ui` scripts
- Both runnable separately (`npm run server` and `npm run ui` in two Terminals)
