import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
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

/** Map key for a (asset, date) price lookup. */
export function priceKey(asset: string, date: string): string {
  return `${asset} ${date}`;
}

/** Keep IN/OR lists well under SQLite's variable limit. */
const PAIR_CHUNK = 200;

/**
 * Batch-resolve many (asset, date) pairs in one round-trip per chunk — avoids
 * an N+1 of `getPrice` when valuing a whole activity feed or position. Missing
 * pairs are simply absent from the returned map (keyed by {@link priceKey}).
 */
export function getPricesForPairs(
  db: Db,
  pairs: ReadonlyArray<{ asset: string; date: string }>,
): Map<string, PriceRow> {
  const out = new Map<string, PriceRow>();
  for (let i = 0; i < pairs.length; i += PAIR_CHUNK) {
    const chunk = pairs.slice(i, i + PAIR_CHUNK);
    const rows = db
      .select()
      .from(prices)
      .where(or(...chunk.map((p) => and(eq(prices.asset, p.asset), eq(prices.date, p.date)))))
      .all();
    for (const row of rows) out.set(priceKey(row.asset, row.date), row);
  }
  return out;
}

/**
 * Most-recent-date price row per asset (for "value at latest close" estimates
 * when an exact event-date price isn't cached). Assets with no rows are absent.
 */
export function getLatestPrices(db: Db, assets: readonly string[]): Map<string, PriceRow> {
  const out = new Map<string, PriceRow>();
  if (assets.length === 0) return out;
  const rows = db
    .select()
    .from(prices)
    .where(inArray(prices.asset, [...assets]))
    .orderBy(asc(prices.asset), asc(prices.date))
    .all();
  // Rows are date-ascending per asset, so the last seen per asset is the latest.
  for (const row of rows) out.set(row.asset, row);
  return out;
}
