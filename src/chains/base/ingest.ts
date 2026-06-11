import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { upsertEvents, type EventInsert } from '../../db/repos/events';
import { upsertRawTxs, type RawTxInsert } from '../../db/repos/raw-txs';
import type { Wallet } from '../../config/wallets-loader';
import type { IngestAdapter, IngestOptions, IngestResult } from '../registry';
import { createBaseClient, createPublicBaseClient } from './client';

/**
 * Base (EVM) ingest adapter — issue #5 ([1A.1]).
 *
 * Enumeration strategy: `alchemy_getAssetTransfers` in BOTH directions across
 * all Base-supported categories (external, internal, erc20, erc721, erc1155)
 * instead of raw `eth_getLogs` chunk-walking — one indexed query per
 * direction, paginated by `pageKey` (no adaptive block chunking needed).
 *
 * vfat Sickle capture: the `base-main-sickle` wallet manages Aerodrome
 * positions through a per-user Sickle proxy (EIP-1167 minimal proxy to vfat's
 * public verified implementation). Sickle↔world transfers never mention the
 * EOA, so after enumerating each owner wallet we probe its transfer
 * counterparties with `eth_getCode`, detect Sickle proxies, and enumerate
 * those addresses too (prior art: liquidity-sheets/tax-report-2025/
 * 02b-vfat-sickle-fetch/fetch_sickle_transfers.py).
 *
 * Storage: raw RPC responses verbatim (hex quantities — no bigint parsing) in
 * `raw_txs` keyed (chain, tx_hash), upsert-idempotent. Each stored tx also
 * gets exactly one `gas:fee` TaxEvent row (gas is a fact about the tx; owned
 * here, not by protocol handlers), fee = gasUsed * effectiveGasPrice + l1Fee
 * (OP-stack L1 data fee — Base txs pay both components).
 */

export const BASE_INGEST_GAS_HANDLER_ID = 'base_ingest_gas';
export const BASE_INGEST_GAS_HANDLER_VERSION = 1;

/**
 * vfat's verified Sickle implementation contracts on Base (public shared
 * infrastructure, not user wallets). Per-user Sickles are EIP-1167 minimal
 * proxies pointing here; discovery never needs user addresses in code.
 */
export const KNOWN_SICKLE_IMPLEMENTATIONS: ReadonlySet<string> = new Set([
  '0xfff75d099baee29f447866bc5299cd67c04761c8',
]);

const ASSET_TRANSFER_CATEGORIES = ['external', 'internal', 'erc20', 'erc721', 'erc1155'] as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const FETCH_CONCURRENCY = 8;
const STORE_CHUNK = 50;

// ---------------------------------------------------------------------------
// Raw RPC shapes (verbatim Alchemy/JSON-RPC payloads, hex quantities)
// ---------------------------------------------------------------------------

export interface AlchemyAssetTransfer {
  hash: string;
  blockNum: string;
  from: string;
  to: string | null;
  category: string;
  asset?: string | null;
  value?: number | null;
  tokenId?: string | null;
  rawContract?: { address?: string | null; value?: string | null; decimal?: string | null };
  erc1155Metadata?: Array<{ tokenId: string; value: string }> | null;
  metadata?: { blockTimestamp?: string };
  uniqueId?: string;
}

export interface RawRpcTransaction {
  hash: string;
  from: string;
  to: string | null;
  blockNumber: string;
  value: string;
  input: string;
  gas: string;
  nonce: string;
  transactionIndex: string;
  [key: string]: unknown;
}

export interface RawRpcLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: string;
  [key: string]: unknown;
}

export interface RawRpcReceipt {
  transactionHash: string;
  status: string;
  gasUsed: string;
  effectiveGasPrice: string;
  /** OP-stack L1 data fee — present on Base receipts. */
  l1Fee?: string | null;
  blockNumber: string;
  from: string;
  to: string | null;
  contractAddress: string | null;
  logs: RawRpcLog[];
  [key: string]: unknown;
}

/** Everything needed to persist one tx; `raw_json` column stores exactly this minus `hash`. */
export interface BaseTxBundle {
  hash: string;
  tx: RawRpcTransaction;
  receipt: RawRpcReceipt;
  /** Unix seconds (from asset-transfer metadata.blockTimestamp). */
  blockTimestamp: number;
  /** All asset-transfer entries Alchemy returned for this hash. */
  transfers: AlchemyAssetTransfer[];
  /** Lowercased owner-side enumeration targets (wallets + sickles) that matched this tx. */
  addresses: string[];
}

/** Shape of `raw_txs.raw_json` for chain=base — protocol handlers parse this. */
export interface BaseRawJson {
  source: 'alchemy';
  tx: RawRpcTransaction;
  receipt: RawRpcReceipt;
  blockTimestamp: number;
  transfers: AlchemyAssetTransfer[];
  addresses: string[];
}

/** Minimal EIP-1193-style request fn — injectable for tests. */
export type RpcRequestFn = (args: { method: string; params: unknown[] }) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Rate limiting — exponential backoff on 429 (issue #5)
// ---------------------------------------------------------------------------

export interface BackoffOptions {
  /** First delay in ms; doubles each retry. */
  baseMs?: number;
  /** Number of retries after the initial attempt. */
  retries?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void> | void;
}

function isRateLimitError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { status?: unknown }).status;
  if (status === 429) return true;
  const message = error instanceof Error ? error.message : '';
  return /\b429\b|rate limit|too many requests|exceeded.*capacity/i.test(message);
}

export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions = {}): Promise<T> {
  const baseMs = opts.baseMs ?? 500;
  const retries = opts.retries ?? 6;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= retries) throw error;
      await sleep(baseMs * 2 ** attempt);
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Total fee in wei: gasUsed * effectiveGasPrice + l1Fee (OP-stack L1 data fee). */
export function computeGasFeeWei(
  receipt: Pick<RawRpcReceipt, 'gasUsed' | 'effectiveGasPrice' | 'l1Fee'>,
): bigint {
  const l2 = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  const l1 = receipt.l1Fee != null ? BigInt(receipt.l1Fee) : 0n;
  return l2 + l1;
}

export function buildRawTxRow(bundle: BaseTxBundle, fetchedAt: number): RawTxInsert {
  const rawJson: BaseRawJson = {
    source: 'alchemy',
    tx: bundle.tx,
    receipt: bundle.receipt,
    blockTimestamp: bundle.blockTimestamp,
    transfers: bundle.transfers,
    addresses: bundle.addresses,
  };
  return {
    chain: 'base',
    txHash: bundle.hash,
    blockNumber: Number(BigInt(bundle.tx.blockNumber)),
    blockTimestamp: bundle.blockTimestamp,
    rawJson,
    fetchedAt,
  };
}

/** The single `gas:fee` event for a stored tx (issue #5: log_index -1 sentinel). */
export function gasEventRowFor(bundle: BaseTxBundle): EventInsert {
  return {
    chain: 'base',
    txHash: bundle.hash,
    logIndex: -1,
    emissionSeq: 0,
    timestamp: bundle.blockTimestamp,
    wallet: bundle.tx.from.toLowerCase(),
    type: 'gas',
    subtype: 'fee',
    sentAsset: 'ETH',
    sentAmount: computeGasFeeWei(bundle.receipt),
    handlerId: BASE_INGEST_GAS_HANDLER_ID,
    handlerVersion: BASE_INGEST_GAS_HANDLER_VERSION,
  };
}

/**
 * EIP-1167 minimal-proxy probe: returns the implementation address iff `code`
 * is a minimal proxy pointing at a known Sickle implementation, else null.
 * Pattern: 0x363d3d373d3d3d363d73 <impl:20 bytes> 5af43d82803e903d91602b57fd5bf3
 */
export function sickleImplementationOf(code: string | null | undefined): string | null {
  if (code == null) return null;
  const c = code.toLowerCase();
  const prefix = '0x363d3d373d3d3d363d73';
  const suffix = '5af43d82803e903d91602b57fd5bf3';
  if (c.length !== prefix.length + 40 + suffix.length) return null;
  if (!c.startsWith(prefix) || !c.endsWith(suffix)) return null;
  const impl = `0x${c.slice(prefix.length, prefix.length + 40)}`;
  return KNOWN_SICKLE_IMPLEMENTATIONS.has(impl) ? impl : null;
}

// ---------------------------------------------------------------------------
// Alchemy enumeration
// ---------------------------------------------------------------------------

async function getAssetTransferPage(
  request: RpcRequestFn,
  params: Record<string, unknown>,
): Promise<{ transfers: AlchemyAssetTransfer[]; pageKey?: string }> {
  const result = await withBackoff(() =>
    request({ method: 'alchemy_getAssetTransfers', params: [params] }),
  );
  return result as { transfers: AlchemyAssetTransfer[]; pageKey?: string };
}

/**
 * All asset transfers touching `address` (both directions, all categories),
 * ascending, from `fromBlock` onwards. Falls back without the `internal`
 * category if the RPC rejects it for this network.
 */
export async function enumerateAssetTransfers(
  request: RpcRequestFn,
  address: string,
  fromBlock: number,
): Promise<AlchemyAssetTransfer[]> {
  const transfers: AlchemyAssetTransfer[] = [];
  let categories: string[] = [...ASSET_TRANSFER_CATEGORIES];
  for (const direction of ['fromAddress', 'toAddress'] as const) {
    let pageKey: string | undefined;
    do {
      const params: Record<string, unknown> = {
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: 'latest',
        [direction]: address,
        category: categories,
        withMetadata: true,
        excludeZeroValue: false,
        maxCount: '0x3e8',
        order: 'asc',
        ...(pageKey !== undefined ? { pageKey } : {}),
      };
      let page: { transfers: AlchemyAssetTransfer[]; pageKey?: string };
      try {
        page = await getAssetTransferPage(request, params);
      } catch (error) {
        if (categories.includes('internal') && isUnsupportedCategoryError(error)) {
          categories = categories.filter((c) => c !== 'internal');
          page = await getAssetTransferPage(request, { ...params, category: categories });
        } else {
          throw error;
        }
      }
      transfers.push(...(page.transfers ?? []));
      pageKey = page.pageKey;
    } while (pageKey !== undefined);
  }
  return transfers;
}

/**
 * "Category not supported" detection for the internal-category fallback.
 * Deliberately strict: viem error messages echo the request body (which
 * always contains the word "category"), so we match the error *details*
 * phrasing only, not the echoed body.
 */
function isUnsupportedCategoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /categor\w*[^.]{0,60}(not supported|unsupported|invalid)|(not supported|unsupported|invalid)[^.]{0,60}categor/i.test(
    message.replace(/Request body: \{.*?\}/gs, ''),
  );
}

/** Alchemy app lacks Base access (network not enabled) — switch to the public-RPC path. */
function isNetworkUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /is not enabled for this app|network.{0,30}not (yet )?supported|unauthorized|must be authenticated/i.test(
    message,
  );
}

// ---------------------------------------------------------------------------
// Fallback enumeration — standard eth_getLogs over a public RPC
// (issue #5's original design; prior art: liquidity-sheets 02b Sickle crawl)
// ---------------------------------------------------------------------------

/** One enumerated tx occurrence, strategy-independent. */
export interface TxRef {
  hash: string;
  blockNum: number;
  /** Unix seconds; 0 when unknown yet (resolved later via eth_getBlockByNumber). */
  timestamp: number;
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// keccak256('TransferSingle(address,address,address,uint256,uint256)')
const TRANSFER_SINGLE_TOPIC = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
// keccak256('TransferBatch(address,address,address,uint256[],uint256[])')
const TRANSFER_BATCH_TOPIC = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';

function pad32(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

interface EnumeratedLog {
  transactionHash: string;
  blockNumber: string;
  topics?: string[];
  /** Tenderly's public gateway includes this; other RPCs may not. */
  blockTimestamp?: string;
}

/** Last 20 bytes of a 32-byte topic as a lowercase address. */
function topicToAddress(topic: string | undefined): string | undefined {
  if (topic === undefined || topic.length !== 66) return undefined;
  return `0x${topic.slice(26).toLowerCase()}`;
}

function isOversizeLogsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /response size|returned more than|more than \d+ (results|logs)|too many|exceed/i.test(
    message,
  );
}

/** `eth_getLogs` with adaptive range bisection on oversize errors (issue #5: adaptive chunking). */
async function getLogsAdaptive(
  request: RpcRequestFn,
  topics: Array<string | null>,
  fromBlock: number,
  toBlock: number,
): Promise<EnumeratedLog[]> {
  try {
    const result = await withBackoff(() =>
      request({
        method: 'eth_getLogs',
        params: [
          {
            fromBlock: `0x${fromBlock.toString(16)}`,
            toBlock: `0x${toBlock.toString(16)}`,
            topics,
          },
        ],
      }),
    );
    return (result ?? []) as EnumeratedLog[];
  } catch (error) {
    if (toBlock <= fromBlock || !isOversizeLogsError(error)) throw error;
    const mid = Math.floor((fromBlock + toBlock) / 2);
    const lower = await getLogsAdaptive(request, topics, fromBlock, mid);
    const upper = await getLogsAdaptive(request, topics, mid + 1, toBlock);
    return [...lower, ...upper];
  }
}

/**
 * Enumerate txs touching `address` via standard Transfer/TransferSingle/
 * TransferBatch logs in both directions. Catches all ERC-20/721/1155
 * movement; plain ETH sends without logs are NOT visible on this path
 * (documented gap — the Alchemy path covers those via `external`/`internal`).
 */
export async function enumerateViaLogs(
  request: RpcRequestFn,
  address: string,
  fromBlock: number,
  counterpartiesOut?: Set<string>,
): Promise<TxRef[]> {
  const padded = pad32(address);
  const filters: Array<Array<string | null>> = [
    [TRANSFER_TOPIC, padded], // ERC-20/721 out
    [TRANSFER_TOPIC, null, padded], // ERC-20/721 in
    [TRANSFER_SINGLE_TOPIC, null, padded], // ERC-1155 from
    [TRANSFER_SINGLE_TOPIC, null, null, padded], // ERC-1155 to
    [TRANSFER_BATCH_TOPIC, null, padded],
    [TRANSFER_BATCH_TOPIC, null, null, padded],
  ];
  const latestHex = await withBackoff(() => request({ method: 'eth_blockNumber', params: [] }));
  const latest = Number(BigInt(latestHex as string));

  const byHash = new Map<string, TxRef>();
  for (const topics of filters) {
    const logs = await getLogsAdaptive(request, topics, fromBlock, latest);
    for (const log of logs) {
      if (counterpartiesOut !== undefined) {
        const isErc1155 = log.topics?.[0] !== TRANSFER_TOPIC;
        const sides = isErc1155
          ? [log.topics?.[2], log.topics?.[3]]
          : [log.topics?.[1], log.topics?.[2]];
        for (const side of sides) {
          const addr = topicToAddress(side);
          if (addr !== undefined) counterpartiesOut.add(addr);
        }
      }
      if (byHash.has(log.transactionHash)) continue;
      byHash.set(log.transactionHash, {
        hash: log.transactionHash,
        blockNum: Number(BigInt(log.blockNumber)),
        timestamp: log.blockTimestamp != null ? Number(BigInt(log.blockTimestamp)) : 0,
      });
    }
  }

  // Resolve timestamps the RPC did not include, one lookup per unique block.
  const blockTsCache = new Map<number, number>();
  for (const ref of byHash.values()) {
    if (ref.timestamp !== 0) continue;
    let ts = blockTsCache.get(ref.blockNum);
    if (ts === undefined) {
      const block = (await withBackoff(() =>
        request({
          method: 'eth_getBlockByNumber',
          params: [`0x${ref.blockNum.toString(16)}`, false],
        }),
      )) as { timestamp?: string } | null;
      ts = block?.timestamp != null ? Number(BigInt(block.timestamp)) : 0;
      blockTsCache.set(ref.blockNum, ts);
    }
    ref.timestamp = ts;
  }
  return [...byHash.values()];
}

/**
 * Probe transfer counterparties for vfat Sickle proxies (EIP-1167 to a known
 * implementation). Returns lowercased Sickle addresses.
 */
export async function discoverSickles(
  request: RpcRequestFn,
  counterparties: ReadonlySet<string>,
  knownAddresses: ReadonlySet<string>,
): Promise<string[]> {
  const candidates = new Set<string>();
  for (const addr of counterparties) {
    if (addr === ZERO_ADDRESS || knownAddresses.has(addr)) continue;
    candidates.add(addr);
  }
  const sickles: string[] = [];
  for (const batch of chunk([...candidates], FETCH_CONCURRENCY)) {
    const codes = await Promise.all(
      batch.map((addr) =>
        withBackoff(() => request({ method: 'eth_getCode', params: [addr, 'latest'] })),
      ),
    );
    for (let i = 0; i < batch.length; i += 1) {
      if (sickleImplementationOf(codes[i] as string) !== null) sickles.push(batch[i]!);
    }
  }
  return sickles;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Idempotent store: raw_txs upsert + exactly one gas:fee event per tx, in
 * short batched transactions (shared WAL DB, concurrent agents). If a tx is
 * already stored, its `addresses` array is merged (union) so per-address
 * cursors stay correct.
 */
export function storeBundles(db: Db, bundles: readonly BaseTxBundle[]): void {
  if (bundles.length === 0) return;
  const fetchedAt = Math.floor(Date.now() / 1000);

  const merged = bundles.map((bundle) => {
    const existing = getStoredRawJson(db, bundle.hash);
    if (existing === undefined) return bundle;
    const prior = JSON.parse(existing) as Partial<BaseRawJson>;
    const union = new Set([...(prior.addresses ?? []), ...bundle.addresses]);
    return { ...bundle, addresses: [...union] };
  });

  upsertRawTxs(
    db,
    merged.map((b) => buildRawTxRow(b, fetchedAt)),
  );
  upsertEvents(db, merged.map(gasEventRowFor));
}

/** `raw_json` string for a stored base tx, or undefined. (drizzle raw `get` returns positional arrays.) */
function getStoredRawJson(db: Db, hash: string): string | undefined {
  const row = db.get<[string] | undefined>(
    sql`SELECT raw_json FROM raw_txs WHERE chain = 'base' AND tx_hash = ${hash}`,
  );
  return row?.[0];
}

/** Distinct enumeration-target addresses tagged on stored base txs (owners + sickles from earlier runs). */
function storedTargetAddresses(db: Db): string[] {
  // NB: drizzle's raw `db.all` returns name-keyed rows, raw `db.get` positional arrays.
  const rows = db.all<{ value: string }>(
    sql`SELECT DISTINCT json_each.value AS value
        FROM raw_txs, json_each(raw_txs.raw_json, '$.addresses')
        WHERE raw_txs.chain = 'base'`,
  );
  return rows.map((r) => r.value);
}

/** Highest already-ingested block among txs tagged with `address` (per-address resume cursor). */
export function maxIngestedBlock(db: Db, address: string): number {
  const row = db.get<[number | null] | undefined>(
    sql`SELECT MAX(raw_txs.block_number)
        FROM raw_txs, json_each(raw_txs.raw_json, '$.addresses')
        WHERE raw_txs.chain = 'base' AND json_each.value = ${address.toLowerCase()}`,
  );
  return row?.[0] ?? 0;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

interface IngestBaseOptions {
  /** Progress logger — counts/labels only, never addresses or keys. */
  log?: (line: string) => void;
  /**
   * Public standard-JSON-RPC endpoint used when the primary (Alchemy) lacks
   * Base access. Enumeration then runs over `eth_getLogs` instead of
   * `alchemy_getAssetTransfers`.
   */
  fallbackRequest?: RpcRequestFn;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function timestampOf(transfer: AlchemyAssetTransfer | undefined): number {
  const iso = transfer?.metadata?.blockTimestamp;
  if (iso === undefined) return 0;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

async function fetchBundle(
  request: RpcRequestFn,
  hash: string,
  transfers: AlchemyAssetTransfer[],
  addresses: string[],
  blockTimestamp: number,
): Promise<BaseTxBundle> {
  const [tx, receipt] = await Promise.all([
    withBackoff(() => request({ method: 'eth_getTransactionByHash', params: [hash] })),
    withBackoff(() => request({ method: 'eth_getTransactionReceipt', params: [hash] })),
  ]);
  if (tx == null || receipt == null) {
    throw new Error(`Base ingest: tx or receipt missing for ${hash}`);
  }
  return {
    hash,
    tx: tx as RawRpcTransaction,
    receipt: receipt as RawRpcReceipt,
    blockTimestamp,
    transfers,
    addresses,
  };
}

/** Per-tx accumulation across all enumeration targets. */
interface TxEntry {
  blockNum: number;
  timestamp: number;
  transfers: AlchemyAssetTransfer[];
  addresses: Set<string>;
}

/**
 * Core ingest over an injectable RPC: enumerate per-address transfers
 * (resuming from each address's max ingested block), discover Sickle proxies,
 * enumerate those too, then fetch + store full tx/receipt bundles for hashes
 * not yet in raw_txs. Stores in chunks as it goes — interruptible/resumable.
 */
export async function ingestBase(
  request: RpcRequestFn,
  db: Db,
  walletAddresses: readonly string[],
  opts: IngestBaseOptions = {},
): Promise<IngestResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const owners = walletAddresses.map((a) => a.toLowerCase());

  let rpc = request;
  let useLogsPath = false;
  const counterparties = new Set<string>();
  const byHash = new Map<string, TxEntry>();

  const enumerateInto = async (target: string): Promise<number> => {
    const fromBlock = maxIngestedBlock(db, target);
    let refs: TxRef[];
    let transfersByHash = new Map<string, AlchemyAssetTransfer[]>();
    if (!useLogsPath) {
      try {
        const transfers = await enumerateAssetTransfers(rpc, target, fromBlock);
        for (const t of transfers) {
          for (const side of [t.from, t.to]) {
            if (side != null) counterparties.add(side.toLowerCase());
          }
          const list = transfersByHash.get(t.hash) ?? [];
          if (!list.some((e) => e.uniqueId !== undefined && e.uniqueId === t.uniqueId)) {
            list.push(t);
          }
          transfersByHash.set(t.hash, list);
        }
        refs = [...transfersByHash.entries()].map(([hash, list]) => ({
          hash,
          blockNum: Number(BigInt(list[0]?.blockNum ?? '0x0')),
          timestamp: timestampOf(list.find((t) => t.metadata?.blockTimestamp !== undefined)),
        }));
      } catch (error) {
        if (opts.fallbackRequest === undefined || !isNetworkUnavailableError(error)) throw error;
        useLogsPath = true;
        rpc = opts.fallbackRequest;
        log(
          'base ingest: Alchemy has no Base access — falling back to public-RPC eth_getLogs enumeration ' +
            '(plain ETH transfers without logs are not visible on this path)',
        );
        return enumerateInto(target);
      }
    } else {
      refs = await enumerateViaLogs(rpc, target, fromBlock, counterparties);
      transfersByHash = new Map();
    }

    for (const ref of refs) {
      const entry = byHash.get(ref.hash) ?? {
        blockNum: ref.blockNum,
        timestamp: ref.timestamp,
        transfers: [],
        addresses: new Set<string>(),
      };
      entry.addresses.add(target);
      if (entry.timestamp === 0) entry.timestamp = ref.timestamp;
      for (const t of transfersByHash.get(ref.hash) ?? []) {
        if (!entry.transfers.some((e) => e.uniqueId !== undefined && e.uniqueId === t.uniqueId)) {
          entry.transfers.push(t);
        }
      }
      byHash.set(ref.hash, entry);
    }
    return refs.length;
  };

  // 1. Enumerate owner wallets (per-address resume cursor).
  for (const [i, owner] of owners.entries()) {
    const count = await enumerateInto(owner);
    log(`base ingest: wallet ${i + 1}/${owners.length} — ${count} txs enumerated`);
  }

  // 2. Discover vfat Sickle proxies among counterparties and enumerate them
  //    too. Targets tagged in earlier runs are re-probed so an incremental
  //    rerun re-enumerates a known Sickle even when no fresh owner transfer
  //    touches it.
  for (const stored of storedTargetAddresses(db)) counterparties.add(stored);
  const sickles = await discoverSickles(rpc, counterparties, new Set(owners));
  log(`base ingest: discovered ${sickles.length} vfat Sickle proxy contract(s)`);
  for (const sickle of sickles) {
    const count = await enumerateInto(sickle);
    log(`base ingest: sickle proxy — ${count} txs enumerated`);
  }

  // 3. Split into new hashes (fetch tx+receipt) and already-stored ones
  //    (skip refetch; merge addresses when a new target saw them).
  const newHashes: string[] = [];
  let skipped = 0;
  const addressMerges: BaseTxBundle[] = [];
  for (const [hash, entry] of byHash) {
    const existing = getStoredRawJson(db, hash);
    if (existing === undefined) {
      newHashes.push(hash);
      continue;
    }
    skipped += 1;
    const prior = JSON.parse(existing) as BaseRawJson;
    const missing = [...entry.addresses].filter((a) => !(prior.addresses ?? []).includes(a));
    if (missing.length > 0) {
      addressMerges.push({
        hash,
        tx: prior.tx,
        receipt: prior.receipt,
        blockTimestamp: prior.blockTimestamp,
        transfers: prior.transfers,
        addresses: [...entry.addresses],
      });
    }
  }
  if (skipped > 0) log(`base ingest: ${skipped} txs already in raw_txs — skipping refetch`);
  if (addressMerges.length > 0) storeBundles(db, addressMerges);

  // 4. Fetch + store new bundles, ascending by block, chunked (resumable).
  newHashes.sort((a, b) => byHash.get(a)!.blockNum - byHash.get(b)!.blockNum);
  let upserted = 0;
  for (const hashChunk of chunk(newHashes, STORE_CHUNK)) {
    const bundles: BaseTxBundle[] = [];
    for (const fetchBatch of chunk(hashChunk, FETCH_CONCURRENCY)) {
      const fetched = await Promise.all(
        fetchBatch.map((hash) => {
          const entry = byHash.get(hash)!;
          return fetchBundle(rpc, hash, entry.transfers, [...entry.addresses], entry.timestamp);
        }),
      );
      bundles.push(...fetched);
    }
    storeBundles(db, bundles);
    upserted += bundles.length;
    log(`base ingest: stored ${upserted}/${newHashes.length} new txs`);
  }

  return { fetched: byHash.size, upserted };
}

// ---------------------------------------------------------------------------
// Adapter registration surface
// ---------------------------------------------------------------------------

type UntypedRequest = (a: { method: string; params: unknown[] }) => Promise<unknown>;

export const baseIngestAdapter: IngestAdapter = {
  chain: 'base',
  async ingest(wallets: readonly Wallet[], opts: IngestOptions): Promise<IngestResult> {
    const fallback = createPublicBaseClient();
    const fallbackRequest: RpcRequestFn = (args) => (fallback.request as UntypedRequest)(args);

    let request = fallbackRequest;
    try {
      const alchemy = createBaseClient(); // throws when ALCHEMY_API_KEY is unset
      request = (args) => (alchemy.request as UntypedRequest)(args);
    } catch {
      console.log('base ingest: no ALCHEMY_API_KEY — using the public Base RPC only');
    }

    return ingestBase(
      request,
      opts.db,
      wallets.map((w) => w.address),
      { fallbackRequest },
    );
  },
};
