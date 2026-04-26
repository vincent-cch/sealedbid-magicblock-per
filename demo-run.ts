// CLI demo runner for the on-chain auction. Runs N auctions against the
// deployed program on Solana devnet + the MagicBlock TEE-protected ER.
//
// Sequential mode (default):
//   npm run demo                          # 3 auctions, USDC via TEE PER
//   npm run demo -- --sol-settle          # synchronous SOL payout
//   npm run demo -- --simulated           # skip settlement (stress only)
//   npm run demo -- --count 5             # custom count
//   npm run demo -- --task echo           # pin task type
//
// Stress mode (parallel waves):
//   npm run demo -- --stress 50 --simulated         # 50 in parallel, no SOL
//   npm run demo -- --stress 50 --sol-settle        # 50 live SOL auctions
//   npm run demo -- --stress 20                     # 20 USDC schedule txs
//   npm run demo -- --stress 50 --stress-concurrent 5
//   npm run demo -- --stress 50 --stress-stagger-ms 300
//   npm run demo -- --stress 50 --quiet             # only the summary table
//
// Stress-mode design:
//   - Worker pool of `--stress-concurrent` (default 10) workers pulls auctions
//     from a shared queue. Each worker re-pulls as soon as its auction lands.
//   - Initial worker launches are staggered by `--stress-stagger-ms` (default
//     200) so they don't all hit base devnet RPC in the same millisecond.
//   - Default output prints one terse line per finished auction, then a
//     percentile summary. `--quiet` suppresses the per-auction lines.
//   - First 3 + last 3 auctions print full tx-receipt links so the BD video
//     has dramatic close-ups without 600 lines of noise.

import 'dotenv/config';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OnchainAuctionCoordinator,
  USDC_DEVNET_MINT,
  type AuctionResult,
  type ProviderEntry,
  type SettlementModeOption,
  type SettlementResult,
  type TaskTypeName,
} from './auction/onchain-coordinator.js';
import { bootstrapProviders } from './scripts/bootstrap-providers.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

const BASE_RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const EPHEMERAL_RPC_URL =
  process.env.MAGICBLOCK_EPHEMERAL_RPC_URL ?? 'https://devnet-tee.magicblock.app';

const TASK_TYPES: TaskTypeName[] = ['image-caption', 'text-summarize', 'echo'];

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function loadKeypair(absolutePath: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(absolutePath, 'utf-8'))),
  );
}

function flagInt(args: string[], name: string, fallback: number): number {
  const idx = args.indexOf(name);
  if (idx < 0) return fallback;
  const n = Number(args[idx + 1] ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

async function main() {
  const args = process.argv.slice(2);
  const taskIdx = args.indexOf('--task');
  const fixedTask = taskIdx >= 0 ? (args[taskIdx + 1] as TaskTypeName) : null;

  const stressCount = flagInt(args, '--stress', 0);
  const stress = stressCount > 0;
  const stressConcurrent = flagInt(args, '--stress-concurrent', 10);
  const stressStaggerMs = flagInt(args, '--stress-stagger-ms', 200);
  const quiet = args.includes('--quiet');

  const seqCount = flagInt(args, '--count', 3);
  const count = stress ? stressCount : seqCount;

  const simulated = args.includes('--simulated');
  const solSettle = args.includes('--sol-settle');
  const settlementMode: SettlementModeOption = simulated
    ? 'simulated'
    : solSettle
      ? 'live-sol'
      : 'live-usdc-tee';

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  const requesterPath = path.join(projectRoot, 'wallets', 'requester.json');
  const fallbackRequester = process.env.HOME
    ? path.join(process.env.HOME, '.config', 'solana', 'id.json')
    : '';

  let requesterKp: Keypair;
  try {
    requesterKp = loadKeypair(requesterPath);
  } catch {
    if (!fallbackRequester) throw new Error('No requester wallet found');
    requesterKp = loadKeypair(fallbackRequester);
  }

  const providers: ProviderEntry[] = [
    {
      keypair: loadKeypair(path.join(projectRoot, 'wallets', 'provider-1.json')),
      name: 'speedy',
      pricing: { 'image-caption': 180_000, 'text-summarize': 400_000, echo: 350_000 },
    },
    {
      keypair: loadKeypair(path.join(projectRoot, 'wallets', 'provider-2.json')),
      name: 'accurate',
      pricing: { 'image-caption': 320_000, 'text-summarize': 220_000 },
    },
    {
      keypair: loadKeypair(path.join(projectRoot, 'wallets', 'provider-3.json')),
      name: 'budget',
      pricing: { 'image-caption': 280_000, echo: 150_000 },
    },
  ];

  if (settlementMode === 'live-sol' || settlementMode === 'live-usdc-tee') {
    try {
      await bootstrapProviders({
        quiet: false,
        ensureUsdcAtas: settlementMode === 'live-usdc-tee',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(c.yellow(`[demo] bootstrap warning: ${msg} (continuing anyway)`));
    }
  }

  const baseConn = new Connection(BASE_RPC_URL, 'confirmed');
  type Balances = { sol: Record<string, number>; usdc: Record<string, bigint> };
  async function readBalances(): Promise<Balances> {
    const wallets = [
      ['requester', requesterKp.publicKey] as const,
      ...providers.map((p) => [p.name, p.keypair.publicKey] as const),
    ];
    const sol: Record<string, number> = {};
    const usdc: Record<string, bigint> = {};
    await Promise.all(wallets.map(async ([name, pk]) => {
      try { sol[name] = await baseConn.getBalance(pk); } catch { sol[name] = -1; }
      try {
        const ata = getAssociatedTokenAddressSync(USDC_DEVNET_MINT, pk);
        const info = await baseConn.getTokenAccountBalance(ata);
        usdc[name] = BigInt(info.value.amount);
      } catch {
        usdc[name] = 0n;
      }
    }));
    return { sol, usdc };
  }
  const balancesBefore = await readBalances();

  const settlementLabel =
    settlementMode === 'live-usdc-tee'
      ? c.green('LIVE USDC via TEE PER')
        + c.dim(' (settle_auction_refund + private transferSpl, validator-pinned)')
      : settlementMode === 'live-sol'
        ? c.green('LIVE SOL')
          + c.dim(' (program-enforced settle_auction; SOL → winner; Job PDA closed)')
        : c.yellow('SIMULATED')
          + c.dim(' (no settle ix; escrow stays stranded in Job PDA)');

  console.log(c.bold(`\n=== SealedBid demo (on-chain${stress ? ', STRESS' : ''}) ===`));
  console.log(`${c.dim('requester    :')} ${c.cyan(requesterKp.publicKey.toBase58())} (${(balancesBefore.sol.requester / LAMPORTS_PER_SOL).toFixed(4)} SOL · ${(Number(balancesBefore.usdc.requester) / 1_000_000).toFixed(4)} USDC)`);
  console.log(`${c.dim('providers    :')} ${providers.map((p) => p.name).join(', ')}`);
  console.log(`${c.dim('base RPC     :')} ${BASE_RPC_URL}`);
  console.log(`${c.dim('ephemeral RPC:')} ${EPHEMERAL_RPC_URL}`);
  console.log(`${c.dim('auctions     :')} ${c.cyan(String(count))}${stress ? c.dim(`  (concurrency=${stressConcurrent}, stagger=${stressStaggerMs}ms)`) : ''}`);
  console.log(`${c.dim('settlement   :')} ${settlementLabel}`);
  console.log('');

  const coordinator = new OnchainAuctionCoordinator(requesterKp, {
    baseRpcUrl: BASE_RPC_URL,
    ephemeralRpcUrl: EPHEMERAL_RPC_URL,
    settlementMode,
  });

  // ── Verbose per-event listeners (sequential mode only) ───────────────────
  // In stress mode, 50 auctions × ~6 events each = 300+ interleaved lines.
  // Skip the chatty listeners and just print one terse line per finished
  // auction below (unless --quiet).
  if (!stress) {
    coordinator.on('job-posted', (e: any) => {
      console.log(`${c.dim('[job-posted]    ')}${c.cyan(e.jobId.slice(0, 8) + '…')}  ${e.description}`);
      console.log(`${c.dim('                ')}${c.dim('sig:')} ${e.sig.slice(0, 16)}…`);
    });
    coordinator.on('job-delegated', (e: any) => {
      console.log(`${c.dim('[job-delegated] ')}${c.cyan(e.jobId.slice(0, 8) + '…')}  ${c.dim('Job is now in PER')}`);
    });
    coordinator.on('job-undelegated', (e: any) => {
      console.log(`${c.dim('[job-undelegated]')}${c.cyan(e.jobId.slice(0, 8) + '…')}  ${c.dim('Job is back on L1')}`);
    });
    coordinator.on('bid-submitted', (e: any) => {
      console.log(`${c.dim('[bid-submitted] ')}${c.cyan(e.jobId.slice(0, 8) + '…')}  ${c.yellow(e.providerName.padEnd(8))} ${e.amountLamports} lamports (conf ${e.confidence})`);
    });
    coordinator.on('bid-rejected', (e: any) => {
      console.log(`${c.dim('[bid-rejected]  ')}${c.cyan(e.jobId.slice(0, 8) + '…')}  ${c.magenta(e.providerName)} ${e.reason || '(no message)'}`);
      if (e.rawError && (e.rawError.logs || e.rawError.transactionLogs)) {
        const logs = e.rawError.logs ?? e.rawError.transactionLogs ?? [];
        for (const l of logs.slice(-12)) console.log(`${c.dim('    ↳ ')}${l}`);
      }
    });
    coordinator.on('close-auction-failed', (e: any) => {
      console.log(`${c.dim('[close-auction-failed]')}${c.cyan(e.jobId.slice(0, 8) + '…')}  ${c.magenta(e.error || '(no message)')}`);
      if (e.rawError && (e.rawError.logs || e.rawError.transactionLogs)) {
        const logs = e.rawError.logs ?? e.rawError.transactionLogs ?? [];
        for (const l of logs.slice(-15)) console.log(`${c.dim('    ↳ ')}${l}`);
      }
    });
    coordinator.on('auction-closed', (r: AuctionResult) => {
      if (r.winner) {
        console.log(
          `${c.dim('[auction-closed]')}${c.cyan(r.jobId.slice(0, 8) + '…')}  ${c.green('WINNER')} ${c.bold(r.winner.providerName)} @ ${r.winner.amountLamports} lamports  ${c.dim('(' + r.clearingMs + 'ms · ' + r.totalBids + ' bids)')}`,
        );
      } else {
        console.log(`${c.dim('[auction-closed]')}${c.cyan(r.jobId.slice(0, 8) + '…')}  ${c.magenta('NO WINNER')} ${c.dim('(' + r.totalBids + ' bids)')}`);
      }
    });
    coordinator.on('settled', (s: SettlementResult) => {
      if (s.mode === 'live-sol') {
        console.log(
          `${c.dim('[settled]       ')}${c.cyan(s.jobId.slice(0, 8) + '…')}  ${c.green('LIVE SOL')} ${s.amountLamports} lamports → ${s.winner!.slice(0, 8)}…  ${c.dim('refund=' + s.requesterRefundLamports + 'L → requester')}`,
        );
        console.log(`${c.dim('                ')}${c.dim('sig:')} ${s.sig.slice(0, 16)}…  ${c.cyan(s.explorerUrl ?? '')}`);
      } else if (s.mode === 'live-usdc-tee') {
        console.log(
          `${c.dim('[settled]       ')}${c.cyan(s.jobId.slice(0, 8) + '…')}  ${c.green('LIVE USDC')} ${s.usdcAmountMicro} µUSDC → ${s.winner!.slice(0, 8)}…  ${c.dim('(private, TEE-encrypted, async-finalized)')}`,
        );
        console.log(
          `${c.dim('                ')}${c.dim('refund tx :')} ${s.sig.slice(0, 16)}…  ${c.dim('(' + s.requesterRefundLamports + 'L SOL refunded)')}`,
        );
        console.log(
          `${c.dim('                ')}${c.dim('schedule  :')} ${(s.usdcScheduleSig ?? '').slice(0, 16)}…  ${c.cyan('https://explorer.solana.com/tx/' + (s.usdcScheduleSig ?? '') + '?cluster=devnet')}`,
        );
      } else if (s.mode === 'simulated') {
        console.log(`${c.dim('[settled]       ')}${c.cyan(s.jobId.slice(0, 8) + '…')}  ${c.yellow('sim')} ${s.amountLamports} lamports  ${c.dim('(' + s.sig + ')')}`);
      } else if (s.mode === 'failed') {
        console.log(`${c.dim('[settled]       ')}${c.cyan(s.jobId.slice(0, 8) + '…')}  ${c.magenta('FAILED')}  ${c.dim(s.error ?? '')}`);
      } else {
        console.log(`${c.dim('[settled]       ')}${c.cyan(s.jobId.slice(0, 8) + '…')}  ${c.dim('skipped (no winner)')}`);
      }
    });
  }

  const startedAt = Date.now();
  const wins: Record<string, number> = Object.fromEntries(providers.map((p) => [p.name, 0]));
  const results: AuctionResult[] = [];
  const settlements = new Map<string, SettlementResult>();
  const durations: number[] = [];
  let cleared = 0;
  let failed = 0;
  let settledLive = 0;
  let settledFailed = 0;
  coordinator.on('settled', (s: SettlementResult) => {
    settlements.set(s.jobId, s);
    if (s.mode === 'live-sol' || s.mode === 'live-usdc-tee') settledLive++;
    if (s.mode === 'failed') settledFailed++;
  });

  /** Run a single auction and update tracking. */
  async function runOne(idx: number): Promise<void> {
    const taskType = fixedTask ?? TASK_TYPES[idx % TASK_TYPES.length];
    const t0 = Date.now();
    try {
      const r = await coordinator.runAuction({
        taskType,
        providers,
        maxBidLamports: 800_000,
        windowMs: 5000,
        description: `${taskType} #${idx + 1}`,
      });
      const ms = Date.now() - t0;
      durations.push(ms);
      results.push(r);
      if (r.winner) {
        cleared++;
        wins[r.winner.providerName] = (wins[r.winner.providerName] ?? 0) + 1;
      }
      if (stress && !quiet) {
        const winnerLabel = r.winner
          ? `${c.bold(r.winner.providerName.padEnd(8))} ${String(r.winner.amountLamports).padStart(7)}L`
          : c.magenta('NO WINNER         ');
        console.log(
          `${c.dim(`[${String(idx + 1).padStart(3)}/${count}]`)} ${taskType.padEnd(15)} ${winnerLabel}  ${c.dim(ms + 'ms · job=' + r.jobId.slice(0, 8) + '…')}`,
        );
      }
    } catch (err) {
      failed++;
      const ms = Date.now() - t0;
      durations.push(ms);
      const msg = err instanceof Error ? err.message : String(err);
      if (!quiet) {
        console.error(c.yellow(`[${String(idx + 1).padStart(3)}/${count}] FAILED  ${msg}`));
      }
    }
  }

  if (stress) {
    // Worker-pool parallel runner.
    const queue = Array.from({ length: count }, (_, i) => i);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    async function worker(): Promise<void> {
      while (queue.length > 0) {
        const i = queue.shift();
        if (i === undefined) return;
        await runOne(i);
      }
    }

    const workers: Promise<void>[] = [];
    for (let w = 0; w < stressConcurrent; w++) {
      if (w > 0 && stressStaggerMs > 0) await sleep(stressStaggerMs);
      workers.push(worker());
    }
    await Promise.all(workers);
  } else {
    for (let i = 0; i < count; i++) {
      console.log(c.bold(`\n--- auction ${i + 1}/${count} (${fixedTask ?? TASK_TYPES[i % TASK_TYPES.length]}) ---`));
      await runOne(i);
    }
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  console.log('');
  console.log(c.bold('=== summary ==='));
  console.log(`${c.dim('cleared      :')} ${c.bold(`${cleared}/${count}`)} in ${c.green(elapsedSec.toFixed(2) + 's')}${failed ? '  ' + c.magenta('failed: ' + failed) : ''}`);
  console.log(
    `${c.dim('winners      :')} ${Object.entries(wins).map(([n, w]) => `${n} ${c.bold(String(w))}`).join(c.dim('  ·  '))}`,
  );
  console.log(`${c.dim('settled live :')} ${c.bold(String(settledLive))}${settledFailed ? '  ' + c.magenta('failed: ' + settledFailed) : ''}`);

  if (stress) {
    const sortedDurations = [...durations].sort((a, b) => a - b);
    const p50 = percentile(sortedDurations, 50);
    const p95 = percentile(sortedDurations, 95);
    const p99 = percentile(sortedDurations, 99);
    const tps = count / elapsedSec;
    console.log(`${c.dim('latency      :')} p50=${c.bold(p50 + 'ms')}  p95=${c.bold(p95 + 'ms')}  p99=${c.bold(p99 + 'ms')}`);
    console.log(`${c.dim('throughput   :')} ${c.green(tps.toFixed(2) + ' auctions/sec')}`);
  }

  if (results.length > 0) {
    // In stress mode dump only the first 3 + last 3 receipts. In sequential
    // mode dump everything (existing behavior).
    const showAll = !stress;
    const showFirstN = 3;
    const showLastN = 3;
    const indices: number[] = showAll
      ? Array.from({ length: results.length }, (_, i) => i)
      : (() => {
          if (results.length <= showFirstN + showLastN) {
            return Array.from({ length: results.length }, (_, i) => i);
          }
          return [
            ...Array.from({ length: showFirstN }, (_, i) => i),
            -1, // sentinel for the elision marker
            ...Array.from({ length: showLastN }, (_, i) => results.length - showLastN + i),
          ];
        })();

    console.log('');
    console.log(c.bold('per-auction tx receipts (devnet explorer):'));
    for (const idx of indices) {
      if (idx === -1) {
        console.log(`  ${c.dim('… (' + (results.length - showFirstN - showLastN) + ' auctions elided) …')}`);
        continue;
      }
      const r = results[idx];
      const settle = settlements.get(r.jobId);
      console.log(`  ${c.cyan(`auction ${idx + 1}`)} ${c.dim(r.jobId.slice(0, 12) + '…')} (${r.taskType})`);
      console.log(`    ${c.dim('post_job    :')} https://explorer.solana.com/tx/${r.sigs.postJob}?cluster=devnet`);
      console.log(`    ${c.dim('delegate_job:')} https://explorer.solana.com/tx/${r.sigs.delegateJob}?cluster=devnet`);
      if (showAll) {
        for (const sb of r.sigs.submitBids) {
          console.log(`    ${c.dim(`submit_bid ${sb.providerName.padEnd(8)}:`)} ${sb.sig}  ${c.dim('(PER)')}`);
        }
      }
      if (r.sigs.closeAuction) {
        console.log(`    ${c.dim('close_auction:')} ${r.sigs.closeAuction}  ${c.dim('(PER · winner determined on-chain)')}`);
      }
      if (settle?.mode === 'live-sol') {
        console.log(`    ${c.dim('settle_auction:')} ${settle.explorerUrl}  ${c.dim('(reclaim ' + settle.requesterRefundLamports + 'L → requester)')}`);
      } else if (settle?.mode === 'live-usdc-tee') {
        console.log(`    ${c.dim('settle_refund :')} ${settle.explorerUrl}  ${c.dim('(SOL escrow ' + settle.requesterRefundLamports + 'L → requester)')}`);
        console.log(`    ${c.dim('USDC schedule :')} https://explorer.solana.com/tx/${settle.usdcScheduleSig}?cluster=devnet  ${c.dim(settle.usdcAmountMicro + ' µUSDC private xfer')}`);
      } else if (settle?.mode === 'simulated') {
        console.log(`    ${c.dim('settled (sim):')} ${settle.sig}`);
      } else if (settle?.mode === 'failed') {
        console.log(`    ${c.dim('settled FAIL:')} ${c.magenta(settle.error ?? 'unknown')}`);
      } else {
        console.log(`    ${c.dim('settled     :')} (no winner — skipped)`);
      }
    }
  }

  console.log('');
  console.log(c.bold('=== balance changes ==='));
  const balancesAfter = await readBalances();
  const fmtSol = (name: string, before: number, after: number) => {
    const diff = after - before;
    const sign = diff > 0 ? '+' : '';
    const sol = (diff / LAMPORTS_PER_SOL).toFixed(6);
    const colored =
      diff > 0 ? c.green(`${sign}${sol} SOL`) : diff < 0 ? c.yellow(`${sol} SOL`) : c.dim('±0 SOL');
    return `${name.padEnd(10)} ${(before / LAMPORTS_PER_SOL).toFixed(4)} → ${(after / LAMPORTS_PER_SOL).toFixed(4)} SOL  (${colored})`;
  };
  const fmtUsdc = (name: string, before: bigint, after: bigint) => {
    const diff = after - before;
    const sign = diff > 0n ? '+' : '';
    const num = Number(diff) / 1_000_000;
    const colored =
      diff > 0n ? c.green(`${sign}${num.toFixed(6)} USDC`) : diff < 0n ? c.yellow(`${num.toFixed(6)} USDC`) : c.dim('±0 USDC');
    return `${name.padEnd(10)} ${(Number(before) / 1_000_000).toFixed(4)} → ${(Number(after) / 1_000_000).toFixed(4)} USDC (${colored})`;
  };
  console.log(c.dim('  SOL:'));
  console.log(`    ${fmtSol('requester', balancesBefore.sol.requester, balancesAfter.sol.requester)}`);
  for (const p of providers) {
    console.log(`    ${fmtSol(p.name, balancesBefore.sol[p.name], balancesAfter.sol[p.name])}`);
  }
  console.log(c.dim('  USDC:'));
  console.log(`    ${fmtUsdc('requester', balancesBefore.usdc.requester, balancesAfter.usdc.requester)}`);
  for (const p of providers) {
    console.log(`    ${fmtUsdc(p.name, balancesBefore.usdc[p.name], balancesAfter.usdc[p.name])}`);
  }

  // ── Stress-mode aggregate cost summary (cleaner numbers for the video) ──
  if (stress && cleared > 0) {
    const requesterSolDiff = balancesAfter.sol.requester - balancesBefore.sol.requester;
    const requesterUsdcDiff = balancesAfter.usdc.requester - balancesBefore.usdc.requester;
    const avgSolPerAuction = -requesterSolDiff / cleared;
    console.log('');
    console.log(c.bold('=== stress aggregate ==='));
    console.log(`${c.dim('total SOL spent (requester):')} ${c.bold((-requesterSolDiff / LAMPORTS_PER_SOL).toFixed(6) + ' SOL')}  ${c.dim('over ' + cleared + ' cleared auctions')}`);
    console.log(`${c.dim('avg SOL per auction        :')} ${c.bold(avgSolPerAuction.toFixed(0) + ' lamports')}`);
    if (settlementMode === 'live-usdc-tee') {
      console.log(`${c.dim('total µUSDC scheduled       :')} ${c.bold((-Number(requesterUsdcDiff)).toString() + ' µUSDC')}  ${c.dim('= ' + (-Number(requesterUsdcDiff) / 1_000_000).toFixed(4) + ' USDC')}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
