import { and, eq, isNull, sql } from 'drizzle-orm';
import { unclassified } from '../../../db/schema';
import type { Db } from '../client';

export type UnclassifiedInsert = Omit<typeof unclassified.$inferInsert, 'resolvedAt'>;
export type UnclassifiedRow = typeof unclassified.$inferSelect;

/**
 * Idempotent upsert keyed on the (chain, tx_hash) primary key.
 * Matches the decoder-registry semantics: a re-encounter refreshes
 * raw_json + reason, re-opens the row (resolved_at = NULL), and
 * preserves the original first_seen_at.
 */
export function upsertUnclassified(db: Db, row: UnclassifiedInsert): void {
  db.insert(unclassified)
    .values(row)
    .onConflictDoUpdate({
      target: [unclassified.chain, unclassified.txHash],
      set: {
        rawJson: sql`excluded.raw_json`,
        reason: sql`excluded.reason`,
        resolvedAt: null,
      },
    })
    .run();
}

export function resolveUnclassified(
  db: Db,
  chain: string,
  txHash: string,
  resolvedAt: number = Math.floor(Date.now() / 1000),
): void {
  db.update(unclassified)
    .set({ resolvedAt })
    .where(and(eq(unclassified.chain, chain), eq(unclassified.txHash, txHash)))
    .run();
}

export function deleteUnclassified(db: Db, chain: string, txHash: string): void {
  db.delete(unclassified)
    .where(and(eq(unclassified.chain, chain), eq(unclassified.txHash, txHash)))
    .run();
}

export interface ListUnclassifiedFilter {
  chain?: string;
  unresolvedOnly?: boolean;
}

export function listUnclassified(db: Db, filter: ListUnclassifiedFilter = {}): UnclassifiedRow[] {
  const conditions = [];
  if (filter.chain !== undefined) conditions.push(eq(unclassified.chain, filter.chain));
  if (filter.unresolvedOnly) conditions.push(isNull(unclassified.resolvedAt));
  const query = db.select().from(unclassified);
  return (conditions.length > 0 ? query.where(and(...conditions)) : query).all();
}

export function countUnclassifiedByChain(db: Db): Array<{ chain: string; count: number }> {
  return db
    .select({ chain: unclassified.chain, count: sql<number>`count(*)` })
    .from(unclassified)
    .groupBy(unclassified.chain)
    .all();
}
