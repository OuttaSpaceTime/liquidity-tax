import { and, eq, gte, inArray, or } from 'drizzle-orm';
import { events, rawTxs, transferLinks } from '../../db/schema';
import type { Db } from '../db/client';
import { upsertEvents } from '../db/repos/events';
import { deleteUnclassified, upsertUnclassified } from '../db/repos/unclassified';
import { applyLinkTags } from '../linker/run';
import type { Chain, TaxEvent } from '../types/event';
import type {
  AggregationHook,
  DecodeContext,
  DecodedTx,
  GenericRule,
  Handler,
  RawTx,
} from './types';

type PersistTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface RegistryOptions {
  /** Owner wallet addresses per chain, injected by the runtime wallets loader. */
  wallets?: Partial<Record<Chain, readonly string[]>>;
}

/**
 * Two events collided on the (chain, tx_hash, log_index, emission_seq) key —
 * the same key as the DB unique constraint `events_uq`, so collisions are
 * caught here with a descriptive error instead of an opaque SQLite error.
 */
export class DuplicateEmissionError extends Error {
  constructor(existing: TaxEvent, incoming: TaxEvent) {
    super(
      `Duplicate emission for (${existing.chain}, ${existing.txHash}, log_index=${existing.logIndex}, ` +
        `emission_seq=${existing.emissionSeq}, ${existing.type}, ${existing.subtype}): ` +
        `emitted by both '${existing.handlerId}' and '${incoming.handlerId}'`,
    );
    this.name = 'DuplicateEmissionError';
  }
}

/**
 * Three-phase dispatcher, mirroring rotki's `EVMTransactionDecoder`
 * (`onchain/rotki/rotkehlchen/chain/evm/decoding/decoder.py`):
 *
 * 1. Handler dispatch — protocol handlers in registration order
 *    (rotki: `decode_by_address_rules` / `addresses_to_decoders()`).
 * 2. Generic rules fallback — chain-generic transfer rules over components
 *    not claimed in phase 1 (rotki: `try_all_rules` / `decoding_rules()`).
 * 3. Aggregation hooks — priority-ordered post-decode transforms
 *    (rotki: `run_all_post_decoding_rules` / `post_decoding_rules()`),
 *    then duplicate-emission guard and deterministic sort.
 */
export class DecoderRegistry {
  private readonly handlers: Handler[] = [];
  private readonly genericRules: GenericRule[] = [];
  private readonly aggregationHooks: AggregationHook[] = [];

  constructor(
    private readonly db: Db,
    private readonly options: RegistryOptions = {},
  ) {}

  registerHandler(handler: Handler): void {
    if (this.handlers.some((h) => h.id === handler.id)) {
      throw new Error(`Handler with id '${handler.id}' is already registered`);
    }
    this.handlers.push(handler);
  }

  registerGenericRule(rule: GenericRule): void {
    if (this.genericRules.some((r) => r.id === rule.id)) {
      throw new Error(`Generic rule with id '${rule.id}' is already registered`);
    }
    this.genericRules.push(rule);
  }

  registerAggregationHook(hook: AggregationHook): void {
    if (this.aggregationHooks.some((h) => h.id === hook.id)) {
      throw new Error(`Aggregation hook with id '${hook.id}' is already registered`);
    }
    this.aggregationHooks.push(hook);
  }

  handlerIds(): string[] {
    return this.handlers.map((h) => h.id);
  }

  /** Pure three-phase decode of one raw tx. No persistence. */
  decode(raw: RawTx): DecodedTx {
    const decodedEvents: TaxEvent[] = [];
    let anySkip = false;
    const unclassifiedReasons: string[] = [];

    // Phase 1 — handler dispatch in registration order.
    for (const handler of this.handlers) {
      if (handler.chain !== raw.chain) continue;
      if (!handler.matches(raw)) continue;
      const result = handler.decode(raw, this.buildContext(raw, decodedEvents));
      if (result.kind === 'ok') {
        decodedEvents.push(...result.events);
      } else if (result.kind === 'skip') {
        anySkip = true;
      } else {
        unclassifiedReasons.push(`${handler.id}: ${result.reason}`);
      }
    }

    // Phase 2 — generic rules over components not claimed by phase 1.
    const claimedLogIndexes = new Set(decodedEvents.map((e) => e.logIndex));
    for (const rule of this.genericRules) {
      if (rule.chain !== undefined && rule.chain !== raw.chain) continue;
      decodedEvents.push(
        ...rule.apply(raw, this.buildContext(raw, decodedEvents, claimedLogIndexes)),
      );
    }

    // Phase 3 — aggregation hooks by ascending priority (stable on ties).
    let finalEvents = decodedEvents;
    const hooks = [...this.aggregationHooks].sort((a, b) => a.priority - b.priority);
    for (const hook of hooks) {
      finalEvents = hook.apply(
        finalEvents,
        raw,
        this.buildContext(raw, finalEvents, claimedLogIndexes),
      );
    }

    assertNoDuplicateEmissions(finalEvents);
    sortDeterministically(finalEvents);

    // Any handler-reported problem sends the WHOLE tx to the manual queue,
    // even when other handlers decoded events: the handlers implement an
    // all-or-nothing contract (a problem discards their own events), so
    // marking the tx 'decoded' on another handler's partial view would
    // silently understate taxable activity with no trace (review finding —
    // e.g. a Sui PTB whose swap turbos decodes while navi's guard trips).
    if (unclassifiedReasons.length > 0) {
      return { status: 'unclassified', reason: unclassifiedReasons.join('; ') };
    }
    if (finalEvents.length > 0) return { status: 'decoded', events: finalEvents };
    if (anySkip) return { status: 'skipped' };
    return {
      status: 'unclassified',
      reason: 'no handler matched and no generic rule emitted events',
    };
  }

  /**
   * Idempotent decode + persist: inside one transaction, upsert the freshly
   * decoded set on the natural key (chain, tx_hash, log_index, emission_seq)
   * — surrogate `events.id` values stay STABLE across re-decodes, so
   * `transfer_links` rows (which reference events.id) keep joining — and
   * delete rows whose natural key the new decode no longer emits (their
   * transfer_links go with them). Linker tags (bridge/self_transfer flags +
   * subtype) are re-applied from the surviving links after the upsert.
   * Unclassified outcomes upsert into `unclassified` (preserving
   * `first_seen_at`); a classifying or skipping outcome clears the row.
   */
  decodeAndPersist(chain: Chain, txHash: string): DecodedTx {
    const raw = this.db
      .select()
      .from(rawTxs)
      .where(and(eq(rawTxs.chain, chain), eq(rawTxs.txHash, txHash)))
      .get();
    if (raw === undefined) {
      throw new Error(`raw tx not found in raw_txs: ${chain}:${txHash}`);
    }

    const result = this.decode(raw);

    this.db.transaction((tx) => {
      // log_index >= 0 only: negative log indexes are ingest-time sentinel rows
      // (e.g. sui_ingest_gas at -1) outside the decoder's event index space —
      // they must survive re-decodes.
      const existing = tx
        .select({ id: events.id, logIndex: events.logIndex, emissionSeq: events.emissionSeq })
        .from(events)
        .where(and(eq(events.chain, chain), eq(events.txHash, txHash), gte(events.logIndex, 0)))
        .all();
      const freshKeys = new Set(
        result.status === 'decoded'
          ? result.events.map((e) => `${e.logIndex}:${e.emissionSeq}`)
          : [],
      );
      const staleIds = existing
        .filter((row) => !freshKeys.has(`${row.logIndex}:${row.emissionSeq}`))
        .map((row) => row.id);
      if (staleIds.length > 0) {
        // Links referencing deleted events would dangle (and block the linker
        // from re-matching the replacement events) — drop them too.
        tx.delete(transferLinks)
          .where(
            or(
              inArray(transferLinks.outEventId, staleIds),
              inArray(transferLinks.inEventId, staleIds),
            ),
          )
          .run();
        tx.delete(events).where(inArray(events.id, staleIds)).run();
      }

      if (result.status === 'decoded') {
        upsertEvents(tx, result.events.map(toEventRow));
        this.reapplyLinkerTags(tx, chain, txHash);
      }

      if (result.status === 'unclassified') {
        upsertUnclassified(tx, {
          chain,
          txHash,
          rawJson: raw.rawJson,
          reason: result.reason,
          firstSeenAt: Math.floor(Date.now() / 1000),
        });
      } else {
        deleteUnclassified(tx, chain, txHash);
      }
    });

    return result;
  }

  /**
   * Restore linker mutations on this tx's events after a re-decode refreshed
   * their payload columns: links carry the durable truth, events carry the
   * derived tags (one shared policy — src/linker/run.ts applyLinkTags).
   * Rejected links re-apply nothing.
   */
  private reapplyLinkerTags(tx: PersistTx, chain: Chain, txHash: string): void {
    const ids = tx
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.chain, chain), eq(events.txHash, txHash), gte(events.logIndex, 0)))
      .all()
      .map((row) => row.id);
    if (ids.length === 0) return;

    const links = tx
      .select()
      .from(transferLinks)
      .where(or(inArray(transferLinks.outEventId, ids), inArray(transferLinks.inEventId, ids)))
      .all();
    for (const link of links) {
      if (link.status === 'rejected') continue;
      applyLinkTags(tx, link);
    }
  }

  private buildContext(
    raw: RawTx,
    decodedEvents: readonly TaxEvent[],
    claimedLogIndexes: ReadonlySet<number> = new Set<number>(),
  ): DecodeContext {
    return {
      wallets: new Set(this.options.wallets?.[raw.chain as Chain] ?? []),
      decodedEvents,
      claimedLogIndexes,
    };
  }
}

/**
 * Guard key = the 4-tuple (chain, tx_hash, log_index, emission_seq) — exactly
 * the DB unique constraint `events_uq`, so anything that would violate the
 * constraint at persist time fails here first with a descriptive error
 * instead of an opaque SQLite UNIQUE failure.
 */
function assertNoDuplicateEmissions(taxEvents: readonly TaxEvent[]): void {
  const seen = new Map<string, TaxEvent>();
  for (const event of taxEvents) {
    const key = [event.chain, event.txHash, event.logIndex, event.emissionSeq].join(' ');
    const existing = seen.get(key);
    if (existing !== undefined) throw new DuplicateEmissionError(existing, event);
    seen.set(key, event);
  }
}

/** Deterministic final order: (tx_hash, log_index, emission_seq, handler_id). */
function sortDeterministically(taxEvents: TaxEvent[]): void {
  taxEvents.sort(
    (a, b) =>
      compareStrings(a.txHash, b.txHash) ||
      a.logIndex - b.logIndex ||
      a.emissionSeq - b.emissionSeq ||
      compareStrings(a.handlerId, b.handlerId),
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toEventRow(event: TaxEvent): typeof events.$inferInsert {
  return {
    chain: event.chain,
    txHash: event.txHash,
    logIndex: event.logIndex,
    emissionSeq: event.emissionSeq,
    timestamp: event.timestamp,
    wallet: event.wallet,
    type: event.type,
    subtype: event.subtype,
    sentAsset: event.sentAsset ?? null,
    sentAmount: event.sentAmount ?? null,
    receivedAsset: event.receivedAsset ?? null,
    receivedAmount: event.receivedAmount ?? null,
    priceUsdJson: event.priceUsd ?? null,
    positionId: event.positionId ?? null,
    flagsJson: event.flags ?? null,
    handlerId: event.handlerId,
    handlerVersion: event.handlerVersion,
  };
}
