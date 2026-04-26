import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';

/**
 * Shared config. Reads from .env with safe defaults for devnet hack.
 */

export const CLUSTER = (process.env.SOLANA_CLUSTER ?? 'devnet') as 'devnet' | 'mainnet';

export const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';

export const MAGICBLOCK_EPHEMERAL_RPC_URL =
  process.env.MAGICBLOCK_EPHEMERAL_RPC_URL ?? 'https://devnet.magicblock.app';

export const MAGICBLOCK_PAYMENTS_API =
  process.env.MAGICBLOCK_PAYMENTS_API ?? 'https://payments.magicblock.app';

// Devnet TEE validator (confirmed 2026-04-25 by MagicBlock team)
export const TEE_VALIDATOR = new PublicKey(
  process.env.TEE_VALIDATOR_PUBKEY ?? 'MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo',
);

export const AUCTION = {
  durationMs: Number(process.env.AUCTION_DURATION_MS ?? 5000),
  maxBidLamports: Number(process.env.MAX_BID_LAMPORTS ?? 1_000_000),
  minBidLamports: Number(process.env.MIN_BID_LAMPORTS ?? 100_000),
};

export const SEAL_STRATEGY = (process.env.SEAL_STRATEGY ?? 'commit-reveal') as
  | 'commit-reveal'
  | 'tdx'
  | 'tdx-real';

export const WALLETS_DIR = './wallets';
