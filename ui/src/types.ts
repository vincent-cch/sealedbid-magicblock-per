export type AuctionPhase = 'posted' | 'bidding' | 'cleared';

export interface AuctionState {
  jobId: string;
  description: string;
  taskType: string;
  phase: AuctionPhase;
  envelopes: string[];
  winner: { provider: string; providerName: string; amountLamports: number } | null;
  clearingMs: number | null;
  settlement: {
    sig: string;
    /**
     * Mode the server reported. v1 used 'live'; v2 emits 'live-sol' or
     * 'live-usdc-tee' (and 'simulated'). Stays loose so older clients
     * don't crash on a new value.
     */
    mode: string;
    explorerUrl: string | null;
    /** µUSDC scheduled to the winner. Only set in live-usdc-tee mode. */
    usdcAmountMicro?: number;
    /** Schedule tx sig for the private USDC transferSpl bundle. Only set in live-usdc-tee mode. */
    usdcScheduleSig?: string;
  } | null;
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
  | {
      type: 'settled';
      jobId: string;
      sig: string;
      /** v1 'live'; v2 'live-sol' / 'live-usdc-tee' / 'simulated' / 'failed' / 'skipped'. */
      mode: string;
      explorerUrl: string | null;
      ts: number;
      /** Only present in live-usdc-tee mode. */
      usdcAmountMicro?: number;
      usdcScheduleSig?: string;
    };
