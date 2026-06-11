import type { Chain } from '../types/event';
import type { Wallet } from '../config/wallets-loader';
import type { Db } from '../db/client';
import { createSolanaIngestAdapter } from './solana/ingest';
import { baseIngestAdapter } from './base/ingest';
import { createSuiIngestAdapter } from './sui/ingest';

export interface IngestOptions {
  /** Shared SQLite handle (WAL, busy_timeout=5000) — adapters write raw_txs via the repos. */
  db: Db;
  /** Optional lower bound (unix seconds); adapters may approximate by block/slot/checkpoint. */
  since?: number;
}

export interface IngestResult {
  /** Transactions seen at the source (RPC / indexer). */
  fetched: number;
  /** Rows upserted into raw_txs. */
  upserted: number;
}

/**
 * Stage-1 ingest adapter (synthesis doc: "Fetch & Cache" — idempotent,
 * keyed by (chain, tx_hash), raw RPC responses cached verbatim).
 * One adapter per chain; implementations land with phases 1A/1B/1C.
 */
export interface IngestAdapter {
  readonly chain: Chain;
  ingest(wallets: readonly Wallet[], opts: IngestOptions): Promise<IngestResult>;
}

/** Registration map, one adapter per chain. */
export class ChainRegistry {
  private readonly adapters = new Map<Chain, IngestAdapter>();

  register(adapter: IngestAdapter): void {
    if (this.adapters.has(adapter.chain)) {
      throw new Error(`Ingest adapter for chain '${adapter.chain}' is already registered`);
    }
    this.adapters.set(adapter.chain, adapter);
  }

  get(chain: Chain): IngestAdapter | undefined {
    return this.adapters.get(chain);
  }

  chains(): Chain[] {
    return [...this.adapters.keys()];
  }
}

/**
 * Explicit registration list, mirroring `createDefaultRegistry` in
 * `src/decoder/index.ts`. Chain ingest adapters (base/viem, solana/kit,
 * sui) register here as their issues land.
 */
export function createDefaultChainRegistry(): ChainRegistry {
  const registry = new ChainRegistry();
  registry.register(baseIngestAdapter); // [1A.1]
  registry.register(createSolanaIngestAdapter()); // [1B.1]
  registry.register(createSuiIngestAdapter()); // [1C.2]
  return registry;
}
