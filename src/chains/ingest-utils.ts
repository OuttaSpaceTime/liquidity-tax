import type { Db } from '../db/client';
import { upsertEvents, type EventInsert } from '../db/repos/events';
import { upsertRawTxs, type RawTxInsert } from '../db/repos/raw-txs';

/**
 * Shared scaffolding for the polling ingest adapters (solana, sui) — client
 * throttle, retry with exponential backoff, and the buffered raw_txs/events
 * flush. Per-chain defaults (page sizes, request floors, retry counts) stay
 * in the adapters. The Base adapter keeps its own `withBackoff` (rate-limit
 * errors only, viem transport) — different semantics, deliberately not
 * unified.
 */

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Retryable RPC failures: 429 / 5xx (status field or message) and transient network errors. */
export function isRetryableRpcError(error: unknown): boolean {
  const shaped = error as { status?: number; context?: { statusCode?: number } } | null;
  const status = shaped?.status ?? shaped?.context?.statusCode;
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /429|too many requests|rate limit|timeout|timed out|econnreset|fetch failed|502|503|504/i.test(
    message,
  );
}

/**
 * Client-side request floor: each call to the returned function delays until
 * `minIntervalMs` after the previous reservation.
 */
export function createThrottle(
  minIntervalMs: number,
  sleep: (ms: number) => Promise<void>,
): () => Promise<void> {
  let nextAllowedAt = 0;
  return async (): Promise<void> => {
    if (minIntervalMs <= 0) return;
    const current = Date.now();
    const waitMs = nextAllowedAt - current;
    nextAllowedAt = Math.max(current, nextAllowedAt) + minIntervalMs;
    if (waitMs > 0) await sleep(waitMs);
  };
}

export interface RetryOptions {
  /** Retries after the initial attempt. */
  maxRetries: number;
  /** First backoff delay; doubles per attempt. */
  baseMs: number;
  sleep: (ms: number) => Promise<void>;
  isRetryable?: (error: unknown) => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const isRetryable = opts.isRetryable ?? isRetryableRpcError;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= opts.maxRetries || !isRetryable(error)) throw error;
      await opts.sleep(opts.baseMs * 2 ** attempt);
    }
  }
}

export interface IngestBuffer {
  pushRaw(row: RawTxInsert): void;
  pushEvent(row: EventInsert): void;
  /** raw_txs rows waiting for the next flush. */
  pendingRaw(): number;
  /** Persist buffered rows (no-op when empty). Safe to call from finally. */
  flush(): void;
  /** raw_txs rows persisted so far. */
  upserted(): number;
}

/**
 * Buffered raw_txs + events writer: rows flush in small batches so an
 * interrupted run resumes for free on rerun (callers flush in a finally).
 */
export function createIngestBuffer(db: Db): IngestBuffer {
  let rawBuffer: RawTxInsert[] = [];
  let eventBuffer: EventInsert[] = [];
  let upserted = 0;
  return {
    pushRaw: (row) => rawBuffer.push(row),
    pushEvent: (row) => eventBuffer.push(row),
    pendingRaw: () => rawBuffer.length,
    flush: () => {
      if (rawBuffer.length === 0) return;
      upsertRawTxs(db, rawBuffer);
      upsertEvents(db, eventBuffer);
      upserted += rawBuffer.length;
      rawBuffer = [];
      eventBuffer = [];
    },
    upserted: () => upserted,
  };
}
