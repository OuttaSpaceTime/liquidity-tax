import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from '../../db/schema';
import { env } from '../config/env';

/** Drizzle handle over bun:sqlite with the full schema — the one Db type project-wide. */
export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DbClient {
  db: Db;
  sqlite: Database;
  close(): void;
}

/**
 * Open the shared SQLite database. WAL mode is set persistently by
 * `db/migrate.ts`; per-connection pragmas (busy_timeout for concurrent
 * writers, foreign_keys) are set here on every open.
 */
export function openDb(path: string = env.DB_PATH): DbClient {
  const sqlite = new Database(path);
  sqlite.query('PRAGMA busy_timeout = 5000').run();
  sqlite.query('PRAGMA foreign_keys = ON').run();
  const db = drizzle(sqlite, { schema });
  return { db, sqlite, close: () => sqlite.close() };
}
