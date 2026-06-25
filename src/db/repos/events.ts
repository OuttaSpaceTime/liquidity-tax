import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import { events } from '../../../db/schema';
import type { Db, DbTx } from '../client';
import type { TaxEventType } from '../../types/event';

export type EventInsert = typeof events.$inferInsert;
export type EventRow = typeof events.$inferSelect;

/** Keep write transactions short for concurrent WAL writers. */
const BATCH_SIZE = 200;

/**
 * Idempotent upsert keyed on UNIQUE(chain, tx_hash, log_index, emission_seq).
 * The surrogate autoincrement id stays stable on conflict; all payload
 * columns (incl. the bigint amount blobs) are refreshed from the incoming row.
 * Accepts an open transaction (decoder decodeAndPersist) — batches become
 * savepoints there.
 */
export function upsertEvents(db: Db | DbTx, rows: readonly EventInsert[]): void {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    db.transaction((tx) => {
      tx.insert(events)
        .values([...batch])
        .onConflictDoUpdate({
          target: [events.chain, events.txHash, events.logIndex, events.emissionSeq],
          set: {
            timestamp: sql`excluded.timestamp`,
            wallet: sql`excluded.wallet`,
            type: sql`excluded.type`,
            subtype: sql`excluded.subtype`,
            sentAsset: sql`excluded.sent_asset`,
            sentAmount: sql`excluded.sent_amount`,
            receivedAsset: sql`excluded.received_asset`,
            receivedAmount: sql`excluded.received_amount`,
            priceUsdJson: sql`excluded.price_usd_json`,
            positionId: sql`excluded.position_id`,
            flagsJson: sql`excluded.flags_json`,
            handlerId: sql`excluded.handler_id`,
            handlerVersion: sql`excluded.handler_version`,
          },
        })
        .run();
    });
  }
}

export function getEventsByTx(db: Db, chain: string, txHash: string): EventRow[] {
  return db
    .select()
    .from(events)
    .where(and(eq(events.chain, chain), eq(events.txHash, txHash)))
    .orderBy(asc(events.logIndex), asc(events.emissionSeq))
    .all();
}

export function deleteEventsByTx(db: Db, chain: string, txHash: string): void {
  db.delete(events)
    .where(and(eq(events.chain, chain), eq(events.txHash, txHash)))
    .run();
}

export function countEventsByChain(db: Db): Array<{ chain: string; count: number }> {
  return db
    .select({ chain: events.chain, count: sql<number>`count(*)` })
    .from(events)
    .groupBy(events.chain)
    .all();
}

export interface RecentActivityOpts {
  wallet?: string;
  chain?: string;
  type?: TaxEventType;
  positionId?: string;
  /** Keyset cursor: the (timestamp, id) of the last row of the previous page. */
  cursor?: { timestamp: number; id: number } | null;
  limit: number;
}

/**
 * Reverse-chronological event feed (newest first), keyset-paginated on
 * (timestamp DESC, id DESC). The surrogate `id` is the stable tiebreak for
 * events sharing a timestamp — a timestamp-only cursor would drop or repeat
 * ties. Rides the `events_by_wallet(wallet, timestamp)` index when `wallet` is
 * set; the global feed is a scan + sort (fine at solo-dataset scale).
 */
export function recentActivity(db: Db, opts: RecentActivityOpts): EventRow[] {
  const conditions = [];
  if (opts.wallet !== undefined) conditions.push(eq(events.wallet, opts.wallet));
  if (opts.chain !== undefined) conditions.push(eq(events.chain, opts.chain));
  if (opts.type !== undefined) conditions.push(eq(events.type, opts.type));
  if (opts.positionId !== undefined) conditions.push(eq(events.positionId, opts.positionId));
  if (opts.cursor != null) {
    const { timestamp, id } = opts.cursor;
    conditions.push(
      or(
        sql`${events.timestamp} < ${timestamp}`,
        and(eq(events.timestamp, timestamp), sql`${events.id} < ${id}`),
      ),
    );
  }
  const base = db.select().from(events);
  const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
  return filtered.orderBy(desc(events.timestamp), desc(events.id)).limit(opts.limit).all();
}

/**
 * All events of one position in canonical lifecycle order
 * (timestamp, tx_hash, log_index, emission_seq) — the same ordering keys
 * `comparePositionEvents` uses, so a rendered timeline matches the reducer's
 * view. Uses the `events_by_position` index.
 */
export function getEventsByPosition(db: Db, positionId: string): EventRow[] {
  return db
    .select()
    .from(events)
    .where(eq(events.positionId, positionId))
    .orderBy(asc(events.timestamp), asc(events.txHash), asc(events.logIndex), asc(events.emissionSeq))
    .all();
}

export interface TxGroup {
  chain: string;
  txHash: string;
  timestamp: number;
  eventCount: number;
}

export interface ListTransactionsOpts {
  chain?: string;
  wallet?: string;
  limit: number;
  offset?: number;
}

/**
 * Distinct decoded transactions (grouped by chain + tx_hash), newest-first,
 * with a per-tx event count. Backs the Transactions audit view, which then
 * reads each tx's rows with `getEventsByTx`.
 */
export function listTransactions(db: Db, opts: ListTransactionsOpts): TxGroup[] {
  const conditions = [];
  if (opts.chain !== undefined) conditions.push(eq(events.chain, opts.chain));
  if (opts.wallet !== undefined) conditions.push(eq(events.wallet, opts.wallet));
  const base = db
    .select({
      chain: events.chain,
      txHash: events.txHash,
      timestamp: sql<number>`max(${events.timestamp})`,
      eventCount: sql<number>`count(*)`,
    })
    .from(events);
  const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
  return filtered
    .groupBy(events.chain, events.txHash)
    .orderBy(desc(sql`max(${events.timestamp})`))
    .limit(opts.limit)
    .offset(opts.offset ?? 0)
    .all();
}
