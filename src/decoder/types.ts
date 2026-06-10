import type { rawTxs } from '../../db/schema';
import type { Chain, TaxEvent } from '../types/event';

/** A row from the `raw_txs` table — the decoder's only input (source of truth). */
export type RawTx = typeof rawTxs.$inferSelect;

/**
 * Context handed to handlers and generic rules during decode.
 * Mirrors rotki's `DecoderContext` (tx + decoded_events so far), adapted to
 * per-tx dispatch: instead of a per-log cursor, phase-2 rules receive the set
 * of log indexes already claimed by phase-1 handlers.
 */
export interface DecodeContext {
  /** Owner wallet addresses configured for the raw tx's chain (as configured — no case folding; Solana/Sui are case-sensitive). */
  readonly wallets: ReadonlySet<string>;
  /** Events emitted so far for this tx by earlier handlers/rules (read-only view). */
  readonly decodedEvents: readonly TaxEvent[];
  /** Log indexes already claimed by phase-1 handler events. Phase-2 rules must not re-emit for these. */
  readonly claimedLogIndexes: ReadonlySet<number>;
}

export type DecodeResult =
  | { kind: 'ok'; events: TaxEvent[] }
  | { kind: 'skip' }
  | { kind: 'unclassified'; reason: string };

/**
 * Phase-1 protocol handler (rotki: `addresses_to_decoders()` entries).
 * `matches()` must be cheap (address/program-id check against raw_json);
 * `decode()` emits events carrying `logIndex` + `emissionSeq`
 * (0-indexed per handler per log).
 *
 * Note: `version` is a number (not the string in the issue #3 sketch) to match
 * the committed [0.2] schema (`events.handler_version` INTEGER) and
 * `TaxEvent.handlerVersion`.
 */
export interface Handler {
  readonly id: string;
  readonly version: number;
  readonly chain: Chain;
  matches(raw: RawTx): boolean;
  decode(raw: RawTx, ctx: DecodeContext): DecodeResult;
}

/**
 * Phase-2 generic rule (rotki: `decoding_rules()` event rules). Runs on every
 * tx of its chain (all chains when `chain` is omitted) after handlers, for
 * generic ERC-20/SPL/Sui coin movements involving owner wallets. Implementations
 * land with the chain ingestors; this is the contract.
 */
export interface GenericRule {
  readonly id: string;
  readonly version: number;
  /** Restrict to one chain; omit to run on all chains. */
  readonly chain?: Chain;
  apply(raw: RawTx, ctx: DecodeContext): TaxEvent[];
}

/**
 * Phase-3 aggregation hook (rotki: `post_decoding_rules()` `(priority, rule)`
 * tuples). Receives the full event list and returns the transformed list —
 * multi-hop swap collapse, collect+increase linking, looping-pattern flags.
 * Lower priority runs earlier; ties run in registration order.
 */
export interface AggregationHook {
  readonly id: string;
  readonly priority: number;
  apply(events: TaxEvent[], raw: RawTx, ctx: DecodeContext): TaxEvent[];
}

/** Outcome of a full three-phase decode of one tx. */
export type DecodedTx =
  | { status: 'decoded'; events: TaxEvent[] }
  | { status: 'skipped' }
  | { status: 'unclassified'; reason: string };
