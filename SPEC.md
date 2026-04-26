# SealedBid

**A sealed-bid compute auction house for AI agents, on Solana, running inside a MagicBlock Private Ephemeral Rollup.**

Weekend hack spec. 48-72h. Solo build. Devnet. For: MagicBlock Internal Blitz Agentic Hackathon.

---

## One-liner

Agents post compute jobs. Other agents submit sealed bids inside a PER. Winner runs the task. Payment settles to Solana. Runs at server speed, with bids cryptographically hidden until clearing.

## Why this wins

Three MagicBlock narratives collapse into one flow:

1. **Agentic** (hackathon theme match)
2. **Privacy** (PER/TDX is the hero, ties to your BD compliance-first pitch)
3. **Speed** (throughput counter ticks up live on stage)

Every extra feature gets cut. These three have to land.

## The 90-second demo (what judges see)

1. Opening line on slide: "Agents need to transact. Mainnet leaks bids and takes 40 seconds."
2. Requester agent posts job on screen: `caption 500 images, 30s deadline, max 0.001 SOL each`
3. Three provider agents join the PER session automatically.
4. Sealed bids appear as ciphertext. Wait 5s.
5. Auction closes. Winner revealed. Payment escrowed.
6. Winner executes the task, returns output hash. Payment settles to Solana devnet.
7. **The money shot:** split-screen. Same job on Solana mainnet: 40s, bids public, 95% more expensive.
8. Loop: 50 auctions in 60s. Counter ticks up on screen. Done.

## Architecture

```
[Requester Agent]
      |
      v  posts job
[Auction Coordinator]  <----  listens for bids
      |
      |  opens PER session
      v
[PER Session (TDX enclosed)]
      ^
      |  sealed bids (encrypted)
      |
[Provider Agent 1] [Provider Agent 2] [Provider Agent 3]
      |
      |  bids stream in
      v
[Coordinator closes after 5s, decrypts inside TDX, picks winner]
      |
      v
[Winner runs compute task off-chain, returns output hash]
      |
      v
[Payment settles from ER back to Solana devnet]
```

## What's NEW (build this)

1. **Agent skeleton** (TypeScript class): wallet, capability profile, bid strategy function
2. **Auction coordinator**: opens PER session, collects bids, closes, decrypts inside TDX, picks winner, triggers payment
3. **Sealed bid submission**: bids encrypted at submission, revealed only to TDX-protected coordinator
4. **Mock compute executor**: takes input, returns output hash after 200-500ms fake latency
5. **Demo UI**: split-screen React frontend showing ER vs Solana mainnet

## What's REUSED (don't rebuild)

- PER session setup from `solana-pay-agent-poc/per-proper-flow.mjs`
- TEE transfer logic from `solana-pay-agent-poc/test-private-tee.mjs`
- Devnet wallet patterns from `solana-pay-agent-poc/src/generate-wallet.ts`
- Debug notes from `agentic-commerce/per-private-payment-walkthrough/PER-DEBUG-LOG.md`

## Hourly breakdown (72h, not continuous)

| Block | Hours | Goal |
|-------|-------|------|
| Scaffold | 0-6 | Fork solana-pay-agent-poc. Create `sealedbid/`. Agent class. 3 provider wallets funded on devnet. |
| Core auction | 6-18 | Coordinator module. Sealed bid submission. Timer-based close. Reveal winner. Test with 3 mock bidders. |
| Payment settlement | 18-30 | Hook coordinator to existing PER payment code. Winner paid on settlement. Verify on Solana explorer. |
| Demo UI | 30-42 | React + Vite frontend. Split-screen rig. Live auction counter. Throughput meter. Bids render as ciphertext, then reveal. |
| Polish + stress | 42-54 | Run 50 auctions in 60s. Fix edge cases. Add capability profiles. Start slides. |
| Slides + dry run | 54-72 | 6 slides. Record backup video. Rehearse 5 times. |

## Compute task (keep mocked)

Do NOT implement real LLM inference during the hack. Mock it:

- Input: `caption this image URL`
- Output: pre-defined text string
- Latency: random 200-500ms
- One agent (the "hero" bidder) uses a real Claude API call for realism. Others are mocked.

This keeps auction mechanics as the focus.

## Agent skeleton (pseudocode)

```typescript
class ProviderAgent {
  wallet: Keypair;
  capabilityProfile: { skills: string[], minPrice: number, confidence: number };

  async onJobPosted(job: Job) {
    if (!this.canHandle(job)) return;
    const bid = this.computeBid(job); // includes noise for realism
    const sealed = await this.sealBid(bid, this.session.tdxKey);
    await this.session.submitBid(sealed);
  }

  async onAuctionWon(job: Job) {
    const output = await this.execute(job); // mocked
    await this.session.submitOutputHash(output.hash);
    // coordinator releases payment on settlement
  }
}
```

## Risks + fallbacks

- **TDX encryption trickier than expected.** Fallback: commit-reveal scheme (submit hash, then reveal). Still sealed. Less flashy. Keep both paths ready.
- **Live demo breaks on stage.** Pre-record a clean video. Always have it.
- **Settlement delay on devnet.** Show "settlement in flight" animation. Keep the narrative flowing.
- **Scope creep.** Dutch auction, reputation, coalitions = all CUT. Sealed first-price only.

## Slide deck (6 slides, no more)

1. **Title** - SealedBid: the first sealed-bid auction house for AI agents on Solana
2. **Problem** - Agents need to trade compute. Mainnet leaks bids, costs too much, too slow.
3. **Insight** - Auctions + agents + compliance = PER's perfect use case
4. **Live demo** (marker)
5. **Architecture + numbers** - bids/sec, settlement latency, cost vs mainnet
6. **What this unlocks** - MCP agent marketplace, x402 agent commerce, B2B data brokering

## Questions to ask the MagicBlock team internally

- Is there a reference implementation for multi-party ops in a single PER session?
- Can I get a TDX enclave slot reserved for the hack window?
- Who on eng knows the current PER payment flow best?

## Stretch (post-hack, if demo crushes)

- Dutch auction mode
- Reputation-weighted bidding
- Multi-agent coalition bids
- Real LLM compute integration
- AMM-style continuous matching

## The pitch line when judges ask "why does this matter"

"The x402 protocol is going to route trillions in agent-to-agent payments. Today those payments are public on mainnet and slow. We make them private, instant, and compliant. This is the only way agent commerce works at scale on Solana."
