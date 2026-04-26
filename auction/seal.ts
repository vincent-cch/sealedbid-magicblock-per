import { createHash, randomBytes } from 'crypto';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { blake2b } from '@noble/hashes/blake2b';
import { edwardsToMontgomeryPub } from '@noble/curves/ed25519';
import { Bid, SealedBid } from '../agents/types.js';
import { TEE_VALIDATOR } from '../config.js';

/**
 * Two paths to sealed bids:
 *
 *   1. CommitReveal: hash the bid + nonce. Submit hash. Reveal nonce+bid on close.
 *      Safe, no third-party trust needed. Demo default.
 *
 *   2. TdxRealSeal: encrypt the bid against the MagicBlock TEE validator's ed25519
 *      pubkey using the same primitive the SDK uses for `schedulePrivateTransferIx`
 *      (ed25519→X25519 + nacl.box, blake2b-derived nonce). The on-the-wire envelope
 *      is genuinely sealed — only a holder of the validator's TDX-resident private
 *      key could decrypt it. Reveal is local bookkeeping in this single-process
 *      demo (we don't decrypt the validator-recipient ciphertext; we stored the
 *      plaintext at seal time).
 *
 *      For the production threat model (sealed against the live attested enclave
 *      session pubkey from /fast-quote, decryption inside the TDX), see
 *      PER-INTEGRATION-LOG.md milestone 3.
 *
 * Interface lets the coordinator swap strategies via env.
 */

export interface SealStrategy {
  seal(bid: Bid): Promise<SealedBid>;
  reveal(sealed: SealedBid): Promise<Bid | null>;
}

/* ---------- Commit-Reveal ---------- */

const commitNonces = new Map<string, { nonce: string; bid: Bid }>();

export class CommitRevealSeal implements SealStrategy {
  async seal(bid: Bid): Promise<SealedBid> {
    const nonce = randomBytes(16).toString('hex');
    const commitment = hashBid(bid, nonce);
    commitNonces.set(bid.id, { nonce, bid });
    return {
      id: bid.id,
      jobId: bid.jobId,
      provider: bid.provider,
      envelope: commitment,
      strategy: 'commit-reveal',
    };
  }

  async reveal(sealed: SealedBid): Promise<Bid | null> {
    const record = commitNonces.get(sealed.id);
    if (!record) return null;
    const rehash = hashBid(record.bid, record.nonce);
    if (rehash !== sealed.envelope) return null;
    return record.bid;
  }
}

function hashBid(bid: Bid, nonce: string): string {
  const payload = `${bid.id}|${bid.jobId}|${bid.provider.toBase58()}|${bid.amountLamports}|${bid.confidence}|${nonce}`;
  return createHash('sha256').update(payload).digest('hex');
}

/* ---------- TDX Real Seal (validator pubkey path) ---------- */

/**
 * Mirrors `encryptEd25519Recipient` from the MagicBlock SDK
 * (`instructions/ephemeral-spl-token-program/crypto.ts`). The SDK does not
 * re-export it from the package root, so we inline the same logic here. Keep
 * byte-for-byte identical so a future MagicBlock-side decrypt would still work.
 */
function encryptToValidator(plaintext: Uint8Array, validator: PublicKey): Buffer {
  const recipientX25519 = edwardsToMontgomeryPub(validator.toBytes());
  const ephemeral = nacl.box.keyPair();
  const nonce = blake2b(
    Buffer.concat([Buffer.from(ephemeral.publicKey), Buffer.from(recipientX25519)]),
    { dkLen: nacl.box.nonceLength },
  );
  const ciphertext = nacl.box(
    plaintext,
    nonce,
    recipientX25519,
    ephemeral.secretKey,
  );
  return Buffer.concat([Buffer.from(ephemeral.publicKey), Buffer.from(ciphertext)]);
}

const realPlaintexts = new Map<string, { bid: Bid; envelope: string }>();

export class TdxRealSeal implements SealStrategy {
  async seal(bid: Bid): Promise<SealedBid> {
    const plaintext = Buffer.from(
      JSON.stringify({
        id: bid.id,
        jobId: bid.jobId,
        provider: bid.provider.toBase58(),
        amountLamports: bid.amountLamports,
        confidence: bid.confidence,
      }),
    );
    const envelope = encryptToValidator(plaintext, TEE_VALIDATOR).toString('base64');
    realPlaintexts.set(bid.id, { bid, envelope });
    return {
      id: bid.id,
      jobId: bid.jobId,
      provider: bid.provider,
      envelope,
      strategy: 'tdx',
    };
  }

  async reveal(sealed: SealedBid): Promise<Bid | null> {
    const record = realPlaintexts.get(sealed.id);
    if (!record) return null;
    if (record.envelope !== sealed.envelope) return null;
    return record.bid;
  }
}

export function makeSealStrategy(
  name: 'commit-reveal' | 'tdx' | 'tdx-real',
): SealStrategy {
  if (name === 'tdx' || name === 'tdx-real') return new TdxRealSeal();
  return new CommitRevealSeal();
}
