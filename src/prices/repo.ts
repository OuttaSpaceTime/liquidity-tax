import { and, eq, sql } from 'drizzle-orm';
import { prices } from '../../db/schema';
import type { Db } from '../db/client';

export type PriceInsert = typeof prices.$inferInsert;
export type PriceRow = typeof prices.$inferSelect;

/** Keep write transactions short for concurrent WAL writers. */
const BATCH_SIZE = 200;

/** Idempotent upsert keyed on PRIMARY KEY (asset, date). */
export function upsertPrices(db: Db, rows: readonly PriceInsert[]): void {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    db.transaction((tx) => {
      tx.insert(prices)
        .values([...batch])
        .onConflictDoUpdate({
          target: [prices.asset, prices.date],
          set: {
            usdPrice: sql`excluded.usd_price`,
            eurPrice: sql`excluded.eur_price`,
            source: sql`excluded.source`,
          },
        })
        .run();
    });
  }
}

export function getPrice(db: Db, asset: string, date: string): PriceRow | undefined {
  return db
    .select()
    .from(prices)
    .where(and(eq(prices.asset, asset), eq(prices.date, date)))
    .get();
}

export function countPrices(db: Db): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(prices)
    .get();
  return row?.count ?? 0;
}
