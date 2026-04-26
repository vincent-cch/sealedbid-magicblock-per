import { Keypair, PublicKey } from '@solana/web3.js';
import { randomUUID } from 'crypto';
import { Bid, CapabilityProfile, Job, SealedBid } from './types.js';
import { SealStrategy } from '../auction/seal.js';
import { AUCTION } from '../config.js';

/**
 * ProviderAgent: listens for jobs, bids if it can handle the task,
 * executes on win, returns output hash.
 */
export class ProviderAgent {
  readonly wallet: Keypair;
  readonly profile: CapabilityProfile;
  private seal: SealStrategy;

  constructor(wallet: Keypair, profile: CapabilityProfile, seal: SealStrategy) {
    this.wallet = wallet;
    this.profile = profile;
    this.seal = seal;
  }

  get pubkey(): PublicKey {
    return this.wallet.publicKey;
  }

  /** Called by coordinator when a new job is announced. */
  async onJobPosted(job: Job): Promise<SealedBid | null> {
    const floor = this.profile.pricing[job.taskType];
    if (floor === undefined) return null;

    const amount = this.computeBid(job, floor);
    if (amount > job.maxBidLamports) return null;

    const bid: Bid = {
      id: randomUUID(),
      jobId: job.id,
      provider: this.pubkey,
      amountLamports: amount,
      confidence: this.profile.confidence,
    };

    return this.seal.seal(bid);
  }

  /** Simple bid strategy: random markup above the per-task floor, capped at job max. */
  private computeBid(job: Job, floor: number): number {
    const noise = 0.85 + Math.random() * 0.3; // [0.85, 1.15]
    const ceiling = Math.min(job.maxBidLamports, AUCTION.maxBidLamports);
    const priced = Math.floor(floor * noise);
    return Math.max(AUCTION.minBidLamports, Math.min(priced, ceiling));
  }

  /** Mocked compute. Returns an output "hash" the coordinator can verify. */
  async executeTask(job: Job): Promise<{ outputHash: string; latencyMs: number }> {
    const start = Date.now();
    const fakeLatency = 200 + Math.floor(Math.random() * 300);
    await new Promise((r) => setTimeout(r, fakeLatency));

    const fakeOutput = `output:${job.id}:${this.profile.name}:${Date.now()}`;
    const outputHash = await hashString(fakeOutput);
    return { outputHash, latencyMs: Date.now() - start };
  }
}

async function hashString(s: string): Promise<string> {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(s).digest('hex');
}
