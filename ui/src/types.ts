export type AuctionPhase = 'posted' | 'bidding' | 'cleared';

export interface AuctionState {
  jobId: string;
  description: string;
  taskType: string;
  phase: AuctionPhase;
  envelopes: string[];
  winner: { provider: string; providerName: string; amountLamports: number } | null;
  clearingMs: number | null;
  settlement: { sig: string; mode: 'simulated' | 'live'; explorerUrl: string | null } | null;
  postedAt: number;
  closedAt: number | null;
  hero: boolean;
  removing?: boolean;
}

export type ServerMessage =
  | { type: 'job-posted'; jobId: string; description: string; taskType: string; maxBidLamports: number; ts: number }
  | { type: 'bids-sealed'; jobId: string; envelopes: string[]; ts: number }
  | {
      type: 'auction-closed';
      jobId: string;
      winner: { provider: string; providerName: string; amountLamports: number } | null;
      clearingMs: number;
      totalBids: number;
      ts: number;
    }
  | { type: 'settled'; jobId: string; sig: string; mode: 'simulated' | 'live'; explorerUrl: string | null; ts: number };
