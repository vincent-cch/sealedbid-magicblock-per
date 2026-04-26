# SealedBid Pitch Deck (6 slides, ~5 minutes)

Hand this whole file to Claude Code. It will render a polished `SealedBid.pptx` using `pptxgenjs`.

## Design system

- **Background:** deep navy `#0A0A1F` on every slide
- **Primary text:** off-white `#F5F5FA`
- **Secondary text:** muted blue `#9CA3D9`
- **Brand accent:** Solana purple `#9945FF` (use for headings, key numbers)
- **Live/highlight accent:** Solana green `#14F195` (use sparingly for "live", "real", "now")
- **Hero accent:** magenta `#E91E63` (only on the live tx slide)
- **Header font:** Arial Black (or "Inter Black")
- **Body font:** Inter (fallback Calibri)
- **Title size:** 44pt bold
- **Stat callout size:** 96pt bold (Solana purple)
- **Body size:** 18pt
- **Caption size:** 11pt muted blue
- **Visual motif:** thin Solana purple vertical bar on the left edge (4px wide, 100% height) of every content slide. Skip on title and demo slides.

Keep all backgrounds dark navy. No accent lines under titles. No bullet decorations under titles.

---

## Slide 1: Title

**Background:** dark navy `#0A0A1F`. No left bar.

**Content:**
- Centered, near top: thin off-white text "MAGICBLOCK INTERNAL BLITZ" (12pt, letter-spaced wide, muted blue)
- Centered hero, 80pt bold off-white: **SealedBid**
- Subhead 24pt muted blue, centered: *The agent economy needs sealed-bid auctions. We built one.*
- Bottom-left corner, 11pt muted: "Vincent · April 2026"
- Bottom-right corner, 11pt muted: "Built on MagicBlock Private Ephemeral Rollups"

**Visual:** centered above the SealedBid title, place a small lock icon (or `🔒`) in a Solana purple circle, ~80px wide. The single visual motif of the deck is "sealed."

---

## Slide 2: Problem

**Title (top-left, 44pt bold):** "AI agents need to pay each other. Mainnet can't do it."

**Three-column layout:**

Each column gets a small icon in a Solana purple circle, then a one-word headline (24pt bold), then a short caption.

| Column | Icon | Headline | Caption (16pt muted) |
|--------|------|----------|----------------------|
| 1 | ⚡ | Fast | Auction rounds need to clear in seconds, not 40 |
| 2 | 🔒 | Private | If bids leak, the cheapest provider gets sniped |
| 3 | 🪙 | Cheap | A 16x fee gap kills any high-frequency market |

**Bottom callout (centered, 28pt):**
> *Galaxy projects $3-5T in agent-to-agent commerce by 2030.*
> 18pt muted: "Today the rails don't exist."

---

## Slide 3: Insight

**Title (44pt):** "Sealed-bid auctions are the natural shape of agent compute markets."

**Body, two-column layout:**

**Left column (text, 60% width):**

A short paragraph, 18pt:

"An agent posts a job. Other agents bid in secret. Cheapest wins.

Sealed bids stop front-running. But they only work if the auction clears fast enough that the workload is still relevant, and if the bids are hidden inside something more secure than a public mempool.

Solana can't do that.

A MagicBlock Private Ephemeral Rollup can."

**Right column (visual, 40% width):**

A simple 4-step vertical flow diagram. Each step is a rounded rectangle, dark navy with Solana purple border.

1. **Seal** — bids encrypted in TEE
2. **Reveal** — auction window closes, coordinator decrypts
3. **Execute** — winner runs the task
4. **Settle** — payment lands on Solana

Connect them with thin Solana purple arrows downward.

---

## Slide 4: Live Demo (marker slide)

**Background:** still dark navy.

**Content:** one centered word, 200pt off-white bold: **DEMO**

**Below it, 24pt muted blue:** "localhost:5173"

**Top-right corner, small green dot + "LIVE" in green** — your visual cue that this is the moment to switch to the browser.

When you hit this slide, alt-tab to the SealedBid browser tab, walk through it for 90 seconds, then come back.

---

## Slide 5: The numbers

**Title (44pt):** "What we proved tonight."

**Body: 2x2 grid of stat callouts.** Each cell has a giant number (96pt Solana purple) and a one-line caption (16pt off-white below).

| Top-left | Top-right |
|----------|-----------|
| **8x** faster | **16x** cheaper |
| 5s vs 40s per auction | 0.000142 SOL vs 0.0023 SOL |

| Bottom-left | Bottom-right |
|-------------|--------------|
| **50** auctions in 60s | **TDX-sealed** |
| Parallel, in one PER session | Real cryptographic privacy |

**Below the grid, full-width banner in magenta:**

🟪 **Real on-chain settlement.** Solana Explorer (devnet) — 18pt off-white, with the explorer URL printed below in 14pt monospace muted blue. (Use the explorer URL we got from the hero tx today.)

---

## Slide 6: What this unlocks

**Title (44pt):** "This is the rail for agentic commerce on Solana."

**Three rows, each with an icon + headline + sub-caption:**

| Icon | Headline (24pt bold) | Caption (16pt muted) |
|------|----------------------|----------------------|
| 🤝 | Agent compute markets | Any agent can hire any other agent. Sealed, settled, on-chain. |
| 💳 | x402 + private payments | The only way machine-to-machine stablecoin commerce works at scale. |
| 🏛️ | MiCA-compliant by design | Configurable AML, real privacy. Institutions can plug in. |

**Bottom of slide, centered, 32pt off-white bold:**
> *MagicBlock is the only place this works today.*

**Smaller line below, 16pt muted blue, centered:**
> Built on Private Ephemeral Rollups. Open source. Devnet live.

---

## Build instructions for Claude Code

When you hand this file to Claude Code, tell it:

```
Read SLIDES.md and build a SealedBid.pptx file using pptxgenjs.
Follow the design system exactly: dark navy background, Solana purple primary, off-white text, magenta only on slide 5's live tx banner. 4px purple left-edge bar on all content slides except title and demo. Include the real explorer URL from our hero tx (the one ending in ...F6aA6dT). Save the file to this folder.

After generating, convert it to images using soffice + pdftoppm and visually inspect each slide for overlap, cutoff text, low contrast, or alignment issues. Fix anything broken. Re-render and re-check until clean. Tell me when SealedBid.pptx is ready to open.
```

That's the full spec. The deck should take Claude Code 10-20 minutes to render and QA.
