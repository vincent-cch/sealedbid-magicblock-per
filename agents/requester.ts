import { Keypair, PublicKey } from '@solana/web3.js';
import { randomUUID } from 'crypto';
import { AuctionResult, Job } from './types.js';
import { AUCTION } from '../config.js';

/**
 * RequesterAgent: posts compute jobs, waits for auction result, releases payment.
 * Payment settlement is triggered by coordinator. This class just authors the job
 * and confirms receipt of output hash.
 */
export class RequesterAgent {
  readonly wallet: Keypair;
  readonly name: string;

  constructor(wallet: Keypair, name = 'requester') {
    this.wallet = wallet;
    this.name = name;
  }

  get pubkey(): PublicKey {
    return this.wallet.publicKey;
  }

  createJob(params: {
    taskType: Job['taskType'];
    input: unknown;
    description: string;
    maxBidLamports?: number;
  }): Job {
    return {
      id: randomUUID(),
      requester: this.pubkey,
      description: params.description,
      taskType: params.taskType,
      input: params.input,
      maxBidLamports: params.maxBidLamports ?? AUCTION.maxBidLamports,
      closeAt: Date.now() + AUCTION.durationMs,
    };
  }

  onAuctionComplete(result: AuctionResult, outputHash: string | null): void {
    if (!result.winner) {
      console.log(`[${this.name}] job ${result.jobId} had no valid bids`);
      return;
    }
    console.log(
      `[${this.name}] job ${result.jobId.slice(0, 8)}: won by ${result.winner.provider
        .toBase58()
        .slice(0, 8)}... at ${result.winner.amountLamports} lamports. output ${outputHash?.slice(0, 12)}...`,
    );
  }
}
