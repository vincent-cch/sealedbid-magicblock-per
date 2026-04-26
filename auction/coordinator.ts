import { EventEmitter } from 'events';
import { ProviderAgent } from '../agents/agent.js';
import { RequesterAgent } from '../agents/requester.js';
import { AuctionResult, Bid, Job, SealedBid } from '../agents/types.js';
import { SealStrategy } from './seal.js';
import { settlePayment, SettleResult } from './settle.js';

/**
 * AuctionCoordinator: orchestrates the full flow.
 *
 *   1. Requester creates a job
 *   2. Coordinator announces to providers
 *   3. Providers submit sealed bids
 *   4. Timer fires at job.closeAt
 *   5. Coordinator reveals bids, picks lowest-price winner
 *   6. Winner executes task, returns output hash
 *   7. Coordinator settles payment (simulated or live)
 *
 * Style B: the 'live' flag on runAuction is false by default. We flip it to
 * true for the final hero auction of the demo so the audience sees one real
 * Solana devnet tx with an explorer link.
 */
export class AuctionCoordinator extends EventEmitter {
  private providers: ProviderAgent[] = [];
  private seal: SealStrategy;

  constructor(seal: SealStrategy, providers: ProviderAgent[]) {
    super();
    this.seal = seal;
    this.providers = providers;
  }

  async runAuction(
    requester: RequesterAgent,
    job: Job,
    opts: { live?: boolean } = {},
  ): Promise<{ result: AuctionResult; outputHash: string | null; settlement: SettleResult | null }> {
    const start = Date.now();
    const mode: 'simulated' | 'live' = opts.live ? 'live' : 'simulated';
    this.emit('job-posted', { job, mode });

    // Collect sealed bids in parallel
    const sealed = (
      await Promise.all(this.providers.map((p) => p.onJobPosted(job)))
    ).filter((b): b is SealedBid => b !== null);

    this.emit('bids-sealed', { jobId: job.id, count: sealed.length });

    // Wait for auction window
    const waitMs = Math.max(0, job.closeAt - Date.now());
    await new Promise((r) => setTimeout(r, waitMs));

    // Reveal
    const revealed: Bid[] = [];
    for (const s of sealed) {
      const b = await this.seal.reveal(s);
      if (b) revealed.push(b);
    }

    // Pick winner (lowest price; tie-broken by confidence)
    const winner =
      revealed.sort((a, b) => {
        if (a.amountLamports !== b.amountLamports) return a.amountLamports - b.amountLamports;
        return b.confidence - a.confidence;
      })[0] ?? null;

    const result: AuctionResult = {
      jobId: job.id,
      winner,
      totalBids: revealed.length,
      clearingMs: Date.now() - start,
    };
    this.emit('auction-closed', result);

    if (!winner) {
      requester.onAuctionComplete(result, null);
      return { result, outputHash: null, settlement: null };
    }

    // Winner executes
    const winningAgent = this.providers.find((p) => p.pubkey.equals(winner.provider));
    if (!winningAgent) throw new Error('winner agent not found in provider list');
    const { outputHash } = await winningAgent.executeTask(job);
    this.emit('task-complete', { jobId: job.id, outputHash });

    // Settle (simulated or live)
    const settlement = await settlePayment({
      from: requester.wallet,
      to: winner.provider,
      lamports: winner.amountLamports,
      jobId: job.id,
      mode,
    });
    this.emit('settled', { jobId: job.id, settlement });

    requester.onAuctionComplete(result, outputHash);
    return { result, outputHash, settlement };
  }
}
