import { and, eq, sql } from 'drizzle-orm';
import { rawTxs } from '../../../db/schema';
import type { Db } from '../client';

export type RawTxInsert = typeof rawTxs.$inferInsert;
export type RawTxRow = typeof rawTxs.$inferSelect;

/** Keep write transactions short for concurrent WAL writers. */
const BATCH_SIZE = 200;

/**
 * Idempotent upsert keyed on the (chain, tx_hash) primary key.
 * Re-running an ingest refreshes the payload instead of duplicating rows.
 */
export function upsertRawTxs(db: Db, rows: readonly RawTxInsert[]): void {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    db.transaction((tx) => {
      tx.insert(rawTxs)
        .values([...batch])
        .onConflictDoUpdate({
          target: [rawTxs.chain, rawTxs.txHash],
          set: {
            blockNumber: sql`excluded.block_number`,
            blockTimestamp: sql`excluded.block_timestamp`,
            rawJson: sql`excluded.raw_json`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        })
        .run();
    });
  }
}

export function getRawTx(db: Db, chain: string, txHash: string): RawTxRow | undefined {
  return db
    .select()
    .from(rawTxs)
    .where(and(eq(rawTxs.chain, chain), eq(rawTxs.txHash, txHash)))
    .get();
}

/** Lightweight key listing (no raw_json) for decode loops. */
export function listRawTxKeys(db: Db, chain?: string): Array<{ chain: string; txHash: string }> {
  const query = db.select({ chain: rawTxs.chain, txHash: rawTxs.txHash }).from(rawTxs);
  return (chain === undefined ? query : query.where(eq(rawTxs.chain, chain))).all();
}

export function countRawTxsByChain(db: Db): Array<{ chain: string; count: number }> {
  return db
    .select({ chain: rawTxs.chain, count: sql<number>`count(*)` })
    .from(rawTxs)
    .groupBy(rawTxs.chain)
    .all();
}
