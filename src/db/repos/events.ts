import { and, asc, eq, sql } from 'drizzle-orm';
import { events } from '../../../db/schema';
import type { Db } from '../client';

export type EventInsert = typeof events.$inferInsert;
export type EventRow = typeof events.$inferSelect;

/** Keep write transactions short for concurrent WAL writers. */
const BATCH_SIZE = 200;

/**
 * Idempotent upsert keyed on UNIQUE(chain, tx_hash, log_index, emission_seq).
 * The surrogate autoincrement id stays stable on conflict; all payload
 * columns (incl. the bigint amount blobs) are refreshed from the incoming row.
 */
export function upsertEvents(db: Db, rows: readonly EventInsert[]): void {
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
