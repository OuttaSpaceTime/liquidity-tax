import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { events, positions } from '../../db/schema';
import type { Db } from '../db/client';
import { reducePositionEvents, type PositionSnapshot, type PositionState } from './tracker';

export type PositionRow = typeof positions.$inferSelect;
export type PositionInsert = typeof positions.$inferInsert;

/** Keep write transactions short for concurrent WAL writers. */
const BATCH_SIZE = 200;

export interface RebuildResult {
  upserted: number;
  deleted: number;
}

export interface ListPositionsOptions {
  chain?: string;
  wallet?: string;
  /** Only positions without a closedAt. */
  openOnly?: boolean;
}

export function getPosition(db: Db, positionId: string): PositionRow | undefined {
  return db.select().from(positions).where(eq(positions.positionId, positionId)).get();
}

/** Typed view over `state_json` (written exclusively by the rebuild path). */
export function positionState(row: PositionRow): PositionState {
  return row.stateJson as PositionState;
}

export function listPositions(db: Db, options: ListPositionsOptions = {}): PositionRow[] {
  const conditions = [];
  if (options.chain !== undefined) conditions.push(eq(positions.chain, options.chain));
  if (options.wallet !== undefined) conditions.push(eq(positions.wallet, options.wallet));
  if (options.openOnly === true) conditions.push(isNull(positions.closedAt));
  const base = db.select().from(positions);
  const query = conditions.length > 0 ? base.where(and(...conditions)) : base;
  return query.orderBy(asc(positions.openedAt), asc(positions.positionId)).all();
}

/**
 * Rebuild the given positions from the `events` table (the only write path
 * for `positions`). Idempotent by construction: state is re-derived from
 * scratch on every call, so re-decoded events are never double-applied.
 * Positions whose events have disappeared are deleted.
 */
export function rebuildPositions(db: Db, positionIds: readonly string[]): RebuildResult {
  const ids = [...new Set(positionIds)];
  const upserts: PositionInsert[] = [];
  const stale: string[] = [];
  for (const positionId of ids) {
    const rows = db.select().from(events).where(eq(events.positionId, positionId)).all();
    const snapshot = reducePositionEvents(positionId, rows);
    if (snapshot === undefined) stale.push(positionId);
    else upserts.push(toPositionRow(snapshot));
  }

  let deleted = 0;
  if (stale.length > 0) {
    db.transaction((tx) => {
      deleted = tx
        .select({ positionId: positions.positionId })
        .from(positions)
        .where(inArray(positions.positionId, stale))
        .all().length;
      tx.delete(positions).where(inArray(positions.positionId, stale)).run();
    });
  }

  for (let i = 0; i < upserts.length; i += BATCH_SIZE) {
    const batch = upserts.slice(i, i + BATCH_SIZE);
    db.transaction((tx) => {
      tx.insert(positions)
        .values(batch)
        .onConflictDoUpdate({
          target: positions.positionId,
          set: {
            chain: sql`excluded.chain`,
            protocol: sql`excluded.protocol`,
            wallet: sql`excluded.wallet`,
            openedAt: sql`excluded.opened_at`,
            closedAt: sql`excluded.closed_at`,
            stateJson: sql`excluded.state_json`,
          },
        })
        .run();
    });
  }

  return { upserted: upserts.length, deleted };
}

/**
 * Full resync: every positionId referenced by `events`, plus existing
 * `positions` rows (so stale rows get cleaned up). Run after a bulk re-decode.
 */
export function rebuildAllPositions(db: Db): RebuildResult {
  const ids = new Set<string>();
  const fromEvents = db
    .selectDistinct({ positionId: events.positionId })
    .from(events)
    .where(isNotNull(events.positionId))
    .all();
  for (const row of fromEvents) if (row.positionId !== null) ids.add(row.positionId);
  const existing = db.select({ positionId: positions.positionId }).from(positions).all();
  for (const row of existing) ids.add(row.positionId);
  return rebuildPositions(db, [...ids]);
}

/**
 * Handler/pipeline entry point: after persisting a decoded batch, resync
 * exactly the positions it touched.
 */
export function syncPositionsForEvents(
  db: Db,
  taxEvents: ReadonlyArray<{ positionId?: string | null }>,
): RebuildResult {
  const ids = new Set<string>();
  for (const event of taxEvents) {
    if (event.positionId !== null && event.positionId !== undefined) ids.add(event.positionId);
  }
  return rebuildPositions(db, [...ids]);
}

function toPositionRow(snapshot: PositionSnapshot): PositionInsert {
  return {
    positionId: snapshot.positionId,
    chain: snapshot.chain,
    protocol: snapshot.protocol,
    wallet: snapshot.wallet,
    openedAt: snapshot.openedAt,
    closedAt: snapshot.closedAt,
    stateJson: snapshot.state,
  };
}
