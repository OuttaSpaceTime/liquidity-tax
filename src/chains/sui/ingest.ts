import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { requireEnv } from '../../config/env';
import type { Wallet } from '../../config/wallets-loader';
import type { Db } from '../../db/client';
import { listRawTxKeys } from '../../db/repos/raw-txs';
import { createIngestBuffer, createThrottle, defaultSleep, withRetry } from '../ingest-utils';
import type { IngestAdapter, IngestOptions, IngestResult } from '../registry';

/**
 * Sui ingest adapter ([1C.2]) — `@mysten/sui` JSON-RPC client against the
 * fullnode configured in `SUI_RPC_URL`.
 *
 * Mirrors the canonical Sui ingest path from
 * `.claude/docs/repo-analysis/_notes-sui.md`: enumerate digests via
 * `suix_queryTransactionBlocks` — one pass filtered `FromAddress` (sent txs)
 * and a second pass `ToAddress` (incoming-only txs: receives, reward
 * airdrops) — dedupe, then fetch each digest once via
 * `sui_getTransactionBlock` with `showEvents + showBalanceChanges +
 * showEffects + showInput` (the option set `sui-tx-explainer` demonstrates,
 * minus objectChanges which handlers do not need: events carry position IDs).
 *
 * Idempotent by digest: digests already present in `raw_txs` are never
 * re-fetched (digest enumeration is cheap; the per-digest
 * `getTransactionBlock` calls are the expensive part). Rows flush in small
 * batches, so an interrupted run resumes for free on rerun.
 *
 * Rate limiting is deliberately GENTLE: public fullnodes allow roughly
 * 100 requests / 30 s per IP, so the default floor is one request per 350 ms
 * (~2.9 req/s) with exponential backoff on 429/5xx.
 *
 * Gas: per the locked decision (doc 05, "Gas fees ... emitted at ingest
 * time"), each ingested tx whose sender is an own wallet gets one `gas:fee`
 * event with `log_index = -1` (sentinel), mirroring `[1A.1]`/`[1B.1]`
 * (`handler_id = 'sui_ingest_gas'`). Sui's net fee is
 * `computationCost + storageCost - storageRebate` (MIST); when object
 * deletions make the rebate exceed the costs the net is a refund, recorded on
 * the received side.
 */

/** Digest-enumeration filters used by the two query passes. */
export type SuiAddressFilter = { FromAddress: string } | { ToAddress: string };

/** Entry of a `suix_queryTransactionBlocks` page (digest + optional timestamp). */
export interface SuiTxBlockSummary {
  digest: string;
  /** Unix milliseconds as decimal string (Sui JSON-RPC convention). */
  timestampMs?: string | null;
}

export interface SuiTxBlockPage {
  data: readonly SuiTxBlockSummary[];
  hasNextPage: boolean;
  nextCursor?: string | null;
}

/** Structural slice of the Sui JSON-RPC client the adapter needs — injectable in tests. */
export interface SuiRpcLike {
  queryTransactionBlocks(params: {
    filter: SuiAddressFilter;
    cursor?: string | null;
    limit?: number;
    order?: 'ascending' | 'descending';
  }): Promise<SuiTxBlockPage>;
  getTransactionBlock(params: {
    digest: string;
    options: {
      showEvents: boolean;
      showBalanceChanges: boolean;
      showEffects: boolean;
      showInput: boolean;
    };
  }): Promise<unknown>;
}

export interface SuiIngestDeps {
  /** Injected RPC (tests). Defaults to `SUI_RPC_URL` from env at ingest time. */
  rpc?: SuiRpcLike;
  /** Digests per `queryTransactionBlocks` page (fullnode QUERY_MAX_RESULT_LIMIT is 50). */
  pageSize?: number;
  /** Persist fetched rows every N txs — resumability granularity. */
  flushEvery?: number;
  /** Minimum gap between RPC calls. Public fullnodes allow ~100 req/30s; default ~2.9 req/s. */
  minRequestIntervalMs?: number;
  /** Retries per RPC call on retryable (429 / 5xx / network) errors. */
  maxRetries?: number;
  /** First backoff delay; doubles per attempt. */
  retryBaseMs?: number;
  /** Re-fetch digests already in raw_txs (payload refresh). */
  forceRefetch?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

const SUI_QUERY_PAGE_LIMIT = 50;

const TX_BLOCK_OPTIONS = {
  showEvents: true,
  showBalanceChanges: true,
  showEffects: true,
  showInput: true,
} as const;

/** Default RPC: `SUI_RPC_URL` fullnode, resolved from env only when ingest actually runs. */
function createSuiRpc(): SuiRpcLike {
  const client = new SuiJsonRpcClient({ url: requireEnv('SUI_RPC_URL'), network: 'mainnet' });
  return {
    async queryTransactionBlocks(params) {
      const page = await client.queryTransactionBlocks({
        filter: params.filter,
        cursor: params.cursor,
        limit: params.limit,
        order: params.order,
      });
      return page;
    },
    getTransactionBlock(params) {
      return client.getTransactionBlock(params);
    },
  };
}

/** Minimal structural view of a SuiTransactionBlockResponse. */
interface SuiTxShape {
  digest?: string;
  /** Checkpoint sequence number as decimal string. */
  checkpoint?: string | null;
  timestampMs?: string | null;
  transaction?: { data?: { sender?: string } } | null;
  effects?: {
    gasUsed?: {
      computationCost?: string;
      storageCost?: string;
      storageRebate?: string;
    };
  } | null;
}

/** Net gas in MIST; negative = net storage rebate (refund). */
function netGasMist(tx: SuiTxShape): bigint | undefined {
  const gas = tx.effects?.gasUsed;
  if (gas?.computationCost === undefined) return undefined;
  return (
    BigInt(gas.computationCost) + BigInt(gas.storageCost ?? 0) - BigInt(gas.storageRebate ?? 0)
  );
}

export function createSuiIngestAdapter(deps: SuiIngestDeps = {}): IngestAdapter {
  const pageSize = Math.min(deps.pageSize ?? SUI_QUERY_PAGE_LIMIT, SUI_QUERY_PAGE_LIMIT);
  const flushEvery = deps.flushEvery ?? 20;
  const minRequestIntervalMs = deps.minRequestIntervalMs ?? 350;
  const maxRetries = deps.maxRetries ?? 6;
  const retryBaseMs = deps.retryBaseMs ?? 1000;
  const forceRefetch = deps.forceRefetch ?? false;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const log = deps.log ?? ((line: string) => console.log(line));

  // Client-side request floor — public fullnodes rate-limit aggressively.
  const throttle = createThrottle(minRequestIntervalMs, sleep);
  const retry = <T>(fn: () => Promise<T>): Promise<T> =>
    withRetry(fn, { maxRetries, baseMs: retryBaseMs, sleep });

  return {
    chain: 'sui',

    async ingest(wallets: readonly Wallet[], opts: IngestOptions): Promise<IngestResult> {
      const rpc = deps.rpc ?? createSuiRpc();
      const db: Db = opts.db;
      const known = new Set(listRawTxKeys(db, 'sui').map((row) => row.txHash));
      const sinceMs = opts.since === undefined ? undefined : opts.since * 1000;

      const buffer = createIngestBuffer(db);

      const ownWallets = new Set(wallets.map((w) => w.address));
      let fetched = 0;

      try {
        for (const wallet of wallets) {
          // 1. Enumerate digests, newest → oldest, in two passes:
          //    FromAddress (sent) then ToAddress (received) — deduped.
          const digests = new Map<string, SuiTxBlockSummary>();
          const passes: SuiAddressFilter[] = [
            { FromAddress: wallet.address },
            { ToAddress: wallet.address },
          ];
          for (const filter of passes) {
            let cursor: string | null | undefined;
            for (;;) {
              await throttle();
              const page = await retry(() =>
                rpc.queryTransactionBlocks({
                  filter,
                  cursor,
                  limit: pageSize,
                  order: 'descending',
                }),
              );
              let reachedSince = false;
              for (const entry of page.data) {
                if (
                  sinceMs !== undefined &&
                  entry.timestampMs != null &&
                  Number(entry.timestampMs) < sinceMs
                ) {
                  reachedSince = true;
                  break;
                }
                if (!digests.has(entry.digest)) digests.set(entry.digest, entry);
              }
              if (reachedSince || !page.hasNextPage || page.nextCursor == null) break;
              cursor = page.nextCursor;
            }
          }

          fetched += digests.size;
          const missing = [...digests.values()].filter(
            (entry) => forceRefetch || !known.has(entry.digest),
          );
          // Privacy: wallet label only, never the address.
          log(`sui ingest [${wallet.label}]: ${digests.size} digests, ${missing.length} to fetch`);

          // 2. Fetch full transaction blocks for unseen digests only (idempotent).
          let done = 0;
          for (const entry of missing) {
            await throttle();
            const tx = (await retry(() =>
              rpc.getTransactionBlock({ digest: entry.digest, options: TX_BLOCK_OPTIONS }),
            )) as SuiTxShape | null;
            done += 1;
            if (tx === null) {
              log(`sui ingest [${wallet.label}]: no transaction block for a digest — skipped`);
              continue;
            }

            const timestampMs = Number(tx.timestampMs ?? entry.timestampMs ?? 0);
            const blockTimestamp = Math.floor(timestampMs / 1000);
            buffer.pushRaw({
              chain: 'sui',
              txHash: entry.digest,
              blockNumber: Number(tx.checkpoint ?? 0),
              blockTimestamp,
              rawJson: tx, // Sui JSON-RPC payloads are JSON-native (u64+ as strings)
              fetchedAt: now(),
            });
            known.add(entry.digest);

            // Gas is a fact about the tx, owned by ingest (locked decision, doc 05).
            const sender = tx.transaction?.data?.sender;
            const fee = netGasMist(tx);
            if (sender !== undefined && fee !== undefined && ownWallets.has(sender)) {
              buffer.pushEvent({
                chain: 'sui',
                txHash: entry.digest,
                logIndex: -1, // sentinel: ingest-time gas row, outside event index space
                emissionSeq: 0,
                timestamp: blockTimestamp,
                wallet: sender,
                type: 'gas',
                subtype: 'fee',
                // Net storage rebates flip the direction: the wallet got SUI back.
                ...(fee >= 0n
                  ? { sentAsset: 'SUI', sentAmount: fee }
                  : { receivedAsset: 'SUI', receivedAmount: -fee }),
                handlerId: 'sui_ingest_gas',
                handlerVersion: 1,
              });
            }

            if (buffer.pendingRaw() >= flushEvery) {
              buffer.flush();
              if (done % 100 === 0) {
                log(`sui ingest [${wallet.label}]: ${done}/${missing.length} txs fetched`);
              }
            }
          }
          buffer.flush();
        }
      } finally {
        // Persist whatever was fetched before an error — rerun resumes after it.
        buffer.flush();
      }

      // fetched = unique digests enumerated per wallet (both passes deduped).
      return { fetched, upserted: buffer.upserted() };
    },
  };
}
