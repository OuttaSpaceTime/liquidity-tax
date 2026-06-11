import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { requireEnv } from '../../config/env';

/**
 * Alchemy Base mainnet URL. The key is loaded lazily at call time via
 * `requireEnv` (never `process.env` directly) so importing this module
 * does not require the key to be configured. Never log the returned URL.
 */
export function alchemyBaseUrl(): string {
  return `https://base-mainnet.g.alchemy.com/v2/${requireEnv('ALCHEMY_API_KEY')}`;
}

/**
 * viem public client for Base (issue #5: `createPublicClient({chain: base,
 * transport: http(ALCHEMY_URL)})`). JSON-RPC batching is intentionally OFF:
 * Alchemy's batched responses trip viem's batch transport for non-standard
 * methods (`alchemy_getAssetTransfers`) — the ingest gets throughput from
 * bounded per-call concurrency instead. viem's built-in transport retry is
 * disabled so the ingest's own 429 exponential backoff governs pacing.
 */
export function createBaseClient() {
  return createPublicClient({
    chain: base,
    transport: http(alchemyBaseUrl(), { retryCount: 0, timeout: 30_000 }),
  });
}

export type BaseClient = ReturnType<typeof createBaseClient>;

/**
 * Keyless public Base RPC (Tenderly gateway): no block-range cap on
 * `eth_getLogs` and per-log `blockTimestamp` (validated by the
 * liquidity-sheets 02b Sickle crawl). Used as the fallback when the Alchemy
 * app has no Base access, and as the primary when no key is configured.
 */
export const PUBLIC_BASE_RPC_URL = 'https://gateway.tenderly.co/public/base';

export function createPublicBaseClient() {
  return createPublicClient({
    chain: base,
    transport: http(PUBLIC_BASE_RPC_URL, { retryCount: 0, timeout: 60_000 }),
  });
}
