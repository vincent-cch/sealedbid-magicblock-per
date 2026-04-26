import { PublicKey } from '@solana/web3.js';

/**
 * Shared types across agents, auction, seal modules.
 */

export type JobId = string;
export type BidId = string;

export interface Job {
  id: JobId;
  requester: PublicKey;
  /** Plain-text description for humans. */
  description: string;
  /** Task type dispatched to compute executor. */
  taskType: 'image-caption' | 'text-summarize' | 'echo';
  input: unknown;
  /** Max the requester will pay per unit of work. Lamports. */
  maxBidLamports: number;
  /** Auction close time as unix ms. */
  closeAt: number;
}

export interface Bid {
  id: BidId;
  jobId: JobId;
  provider: PublicKey;
  /** Lamports the provider is asking for. */
  amountLamports: number;
  /** Self-reported confidence 0-1. Used for tie-breaking. */
  confidence: number;
}

/** Sealed bid as submitted before auction close. */
export interface SealedBid {
  id: BidId;
  jobId: JobId;
  provider: PublicKey;
  /** Opaque ciphertext or commitment hash. */
  envelope: string;
  strategy: 'commit-reveal' | 'tdx';
}

export interface AuctionResult {
  jobId: JobId;
  winner: Bid | null;
  totalBids: number;
  clearingMs: number;
}

export interface CapabilityProfile {
  name: string;
  /**
   * Per-task minimum price in lamports. A task type is supported iff it has
   * an entry here. Lets each provider be cheapest on a different task type
   * so winners actually rotate across the auction stream.
   */
  pricing: Partial<Record<Job['taskType'], number>>;
  /** Self-reported confidence 0-1. */
  confidence: number;
}
