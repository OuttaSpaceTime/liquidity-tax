import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { coingeckoIdFor } from './token-map';

/**
 * Batch-dedup of price lookups, mirroring dali-rp2's TransactionManifest:
 * collect every (asset, date) the events table needs BEFORE touching any
 * price API, so each remote call is spent on a distinct, still-missing pair.
 */

export interface NeededPair {
  asset: string;
  date: string;
}

export interface FetchTask {
  cgId: string;
  date: string;
  /** All asset symbols priced by this (cgId, date) fetch — e.g. ETH + WETH. */
  assets: string[];
}

export interface FetchPlan {
  tasks: FetchTask[];
  unmappedAssets: string[];
}

/**
 * Distinct (asset, UTC date) pairs over events.sent_asset/received_asset that
 * have no prices row yet. Dates derive from events.timestamp (unix seconds).
 */
export function collectNeededPairs(db: Db): NeededPair[] {
  return db.all<NeededPair>(sql`
    SELECT u.asset AS asset, u.date AS date
    FROM (
      SELECT DISTINCT sent_asset AS asset,
                      strftime('%Y-%m-%d', timestamp, 'unixepoch') AS date
      FROM events WHERE sent_asset IS NOT NULL
      UNION
      SELECT DISTINCT received_asset,
                      strftime('%Y-%m-%d', timestamp, 'unixepoch')
      FROM events WHERE received_asset IS NOT NULL
    ) u
    LEFT JOIN prices p ON p.asset = u.asset AND p.date = u.date
    WHERE p.asset IS NULL
    ORDER BY u.date, u.asset
  `);
}

/**
 * (asset, date) pairs already priced USD-only (`eur_price IS NULL` — the
 * DefiLlama fallback writes these). EUR is the load-bearing column for the
 * German §23/§22 report, so these rows are re-pricing candidates, NOT
 * satisfied pairs.
 */
export function collectEurMissingPairs(db: Db): NeededPair[] {
  return db.all<NeededPair>(sql`
    SELECT asset, date FROM prices
    WHERE eur_price IS NULL
    ORDER BY date, asset
  `);
}

/** Group needed pairs by (cgId, date) so aliased assets share one API call. */
export function buildFetchPlan(pairs: readonly NeededPair[]): FetchPlan {
  const byKey = new Map<string, FetchTask>();
  const unmapped = new Set<string>();
  for (const { asset, date } of pairs) {
    const cgId = coingeckoIdFor(asset);
    if (cgId === undefined) {
      unmapped.add(asset);
      continue;
    }
    const key = `${cgId}\u0000${date}`;
    const task = byKey.get(key);
    if (task === undefined) byKey.set(key, { cgId, date, assets: [asset] });
    else task.assets.push(asset);
  }
  const tasks = [...byKey.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.cgId.localeCompare(b.cgId),
  );
  for (const task of tasks) task.assets.sort();
  return { tasks, unmappedAssets: [...unmapped].sort() };
}
