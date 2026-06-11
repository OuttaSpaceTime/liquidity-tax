import { address, createSolanaRpc, signature } from '@solana/kit';
import { requireEnv } from '../../config/env';
import type { Wallet } from '../../config/wallets-loader';
import type { Db } from '../../db/client';
import { upsertEvents, type EventInsert } from '../../db/repos/events';
import { listRawTxKeys, upsertRawTxs, type RawTxInsert } from '../../db/repos/raw-txs';
import type { IngestAdapter, IngestOptions, IngestResult } from '../registry';

/**
 * Solana ingest adapter ([1B.1]) — @solana/kit against Helius RPC.
 *
 * Mirrors the canonical Kit fetch path documented in
 * `.claude/docs/repo-analysis/kit.md` §"Historical Transaction Fetching":
 * `getSignaturesForAddress` paginated newest→oldest via the `before` cursor,
 * then `getTransaction(sig, { encoding: 'jsonParsed',
 * maxSupportedTransactionVersion: 0 })` per signature. Kit ships no retry or
 * pagination loop (kit.md §"Gaps & Limitations" 2–3), so throttling, backoff
 * and cursor management live here.
 *
 * Idempotent by signature: signatures already present in `raw_txs` are never
 * re-fetched (signature enumeration is cheap — 1000/page; the per-tx
 * `getTransaction` calls are the expensive part). Rows flush in small batches,
 * so an interrupted run resumes for free on rerun.
 *
 * Gas: per the locked decision (doc 05, "Gas fees ... emitted at ingest
 * time"), each ingested tx whose fee payer is an own wallet gets one
 * `gas:fee` event with `log_index = -1` (sentinel), mirroring the Base
 * `[1A.1]` spec (`handler_id = 'solana_ingest_gas'`).
 */

/** Entry of a `getSignaturesForAddress` page (kit: `SignaturesForAddressTransaction`). */
export interface SignatureInfo {
  signature: string;
  slot: bigint | number;
  blockTime: bigint | number | null;
  err: unknown;
}

/**
 * Structural slice of Kit's RPC the adapter needs — injectable in tests.
 * Method shorthand keeps parameter bivariance so the branded Kit RPC wrapper
 * assigns cleanly.
 */
export interface SolanaRpcLike {
  getSignaturesForAddress(
    walletAddress: string,
    config?: { before?: string; limit?: number },
  ): { send(): Promise<readonly SignatureInfo[]> };
  getTransaction(
    txSignature: string,
    config?: { encoding?: 'jsonParsed'; maxSupportedTransactionVersion?: 0 },
  ): { send(): Promise<unknown> };
}

export interface SolanaIngestDeps {
  /** Injected RPC (tests). Defaults to Helius mainnet from `HELIUS_API_KEY` at ingest time. */
  rpc?: SolanaRpcLike;
  /** Signatures per `getSignaturesForAddress` page (RPC max 1000). */
  pageSize?: number;
  /** Persist fetched rows every N txs — resumability granularity. */
  flushEvery?: number;
  /** Minimum gap between RPC calls. Helius free tier is 10 req/s; default ~9 req/s. */
  minRequestIntervalMs?: number;
  /** Retries per RPC call on retryable (429 / 5xx / network) errors. */
  maxRetries?: number;
  /** First backoff delay; doubles per attempt. */
  retryBaseMs?: number;
  /** Re-fetch signatures already in raw_txs (payload refresh). */
  forceRefetch?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

const HELIUS_MAINNET = 'https://mainnet.helius-rpc.com/';
const SOLANA_RPC_PAGE_LIMIT = 1000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Lamports per tx fee fit easily in a number, but slots/amounts may not — keep bigints lossless. */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= -BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  }
  return value;
}

function isRetryableError(error: unknown): boolean {
  const statusCode = (error as { context?: { statusCode?: number } } | null)?.context?.statusCode;
  if (statusCode === 429 || statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /429|too many requests|rate limit|timeout|timed out|econnreset|fetch failed|502|503|504/i.test(
    message,
  );
}

/** Default RPC: Helius mainnet, key resolved from env only when ingest actually runs. */
function createHeliusRpc(): SolanaRpcLike {
  const key = requireEnv('HELIUS_API_KEY');
  const rpc = createSolanaRpc(`${HELIUS_MAINNET}?api-key=${key}`);
  return {
    getSignaturesForAddress(walletAddress, config) {
      return rpc.getSignaturesForAddress(address(walletAddress), {
        limit: config?.limit,
        before: config?.before === undefined ? undefined : signature(config.before),
      });
    },
    getTransaction(txSignature, config) {
      return rpc.getTransaction(signature(txSignature), {
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0,
        ...config,
      });
    },
  };
}

/** Minimal structural view of a jsonParsed getTransaction response. */
interface ParsedTxShape {
  slot?: bigint | number;
  blockTime?: bigint | number | null;
  meta?: { fee?: bigint | number } | null;
  transaction?: {
    message?: { accountKeys?: ReadonlyArray<string | { pubkey?: string }> };
  };
}

function feePayerOf(tx: ParsedTxShape): string | undefined {
  const first = tx.transaction?.message?.accountKeys?.[0];
  if (typeof first === 'string') return first;
  return first?.pubkey;
}

export function createSolanaIngestAdapter(deps: SolanaIngestDeps = {}): IngestAdapter {
  const pageSize = Math.min(deps.pageSize ?? SOLANA_RPC_PAGE_LIMIT, SOLANA_RPC_PAGE_LIMIT);
  const flushEvery = deps.flushEvery ?? 25;
  const minRequestIntervalMs = deps.minRequestIntervalMs ?? 110;
  const maxRetries = deps.maxRetries ?? 5;
  const retryBaseMs = deps.retryBaseMs ?? 500;
  const forceRefetch = deps.forceRefetch ?? false;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const log = deps.log ?? ((line: string) => console.log(line));

  // Simple client-side rate limiter for the Helius free tier.
  let nextAllowedAt = 0;
  const throttle = async (): Promise<void> => {
    if (minRequestIntervalMs <= 0) return;
    const current = Date.now();
    const waitMs = nextAllowedAt - current;
    nextAllowedAt = Math.max(current, nextAllowedAt) + minRequestIntervalMs;
    if (waitMs > 0) await sleep(waitMs);
  };

  const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        if (attempt >= maxRetries || !isRetryableError(error)) throw error;
        await sleep(retryBaseMs * 2 ** attempt);
      }
    }
  };

  return {
    chain: 'solana',

    async ingest(wallets: readonly Wallet[], opts: IngestOptions): Promise<IngestResult> {
      const rpc = deps.rpc ?? createHeliusRpc();
      const db: Db = opts.db;
      const known = new Set(listRawTxKeys(db, 'solana').map((row) => row.txHash));

      let fetched = 0;
      let upserted = 0;

      let rawBuffer: RawTxInsert[] = [];
      let eventBuffer: EventInsert[] = [];
      const flush = (): void => {
        if (rawBuffer.length === 0) return;
        upsertRawTxs(db, rawBuffer);
        upsertEvents(db, eventBuffer);
        upserted += rawBuffer.length;
        rawBuffer = [];
        eventBuffer = [];
      };

      const ownWallets = new Set(wallets.map((w) => w.address));

      try {
        for (const wallet of wallets) {
          // 1. Enumerate full signature history, newest → oldest (before-cursor).
          const sigInfos: SignatureInfo[] = [];
          let before: string | undefined;
          for (;;) {
            await throttle();
            const page = await withRetry(() =>
              rpc.getSignaturesForAddress(wallet.address, { limit: pageSize, before }).send(),
            );
            let reachedSince = false;
            for (const info of page) {
              if (opts.since !== undefined && info.blockTime !== null && Number(info.blockTime) < opts.since) {
                reachedSince = true;
                break;
              }
              sigInfos.push(info);
            }
            if (reachedSince || page.length < pageSize) break;
            before = page[page.length - 1].signature;
          }
          fetched += sigInfos.length;

          const missing = sigInfos.filter((info) => forceRefetch || !known.has(info.signature));
          // Privacy: wallet label only, never the address.
          log(
            `solana ingest [${wallet.label}]: ${sigInfos.length} signatures, ${missing.length} to fetch`,
          );

          // 2. Fetch full transactions for unseen signatures only (idempotent).
          let done = 0;
          for (const info of missing) {
            await throttle();
            const tx = (await withRetry(() =>
              rpc
                .getTransaction(info.signature, {
                  encoding: 'jsonParsed',
                  maxSupportedTransactionVersion: 0,
                })
                .send(),
            )) as ParsedTxShape | null;
            done += 1;
            if (tx === null) {
              log(`solana ingest [${wallet.label}]: no transaction for a signature — skipped`);
              continue;
            }

            const blockTimestamp = Number(tx.blockTime ?? info.blockTime ?? 0);
            rawBuffer.push({
              chain: 'solana',
              txHash: info.signature,
              blockNumber: Number(tx.slot ?? info.slot),
              blockTimestamp,
              rawJson: toJsonSafe(tx),
              fetchedAt: now(),
            });
            known.add(info.signature);

            // Gas is a fact about the tx, owned by ingest (locked decision, doc 05).
            const feePayer = feePayerOf(tx);
            const fee = tx.meta?.fee;
            if (feePayer !== undefined && fee !== undefined && ownWallets.has(feePayer)) {
              eventBuffer.push({
                chain: 'solana',
                txHash: info.signature,
                logIndex: -1, // sentinel: ingest-time gas row, outside instruction index space
                emissionSeq: 0,
                timestamp: blockTimestamp,
                wallet: feePayer,
                type: 'gas',
                subtype: 'fee',
                sentAsset: 'SOL',
                sentAmount: BigInt(fee),
                handlerId: 'solana_ingest_gas',
                handlerVersion: 1,
              });
            }

            if (rawBuffer.length >= flushEvery) {
              flush();
              if (done % 200 === 0) {
                log(`solana ingest [${wallet.label}]: ${done}/${missing.length} txs fetched`);
              }
            }
          }
          flush();
        }
      } finally {
        // Persist whatever was fetched before an error — rerun resumes after it.
        flush();
      }

      return { fetched, upserted };
    },
  };
}
