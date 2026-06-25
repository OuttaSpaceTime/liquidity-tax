import 'server-only';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from '@db/schema';

/**
 * Readonly handle on the same SQLite file the CLI writes (doc 07 §2.3: CLI is
 * the sole writer + migration runner; the dashboard only ever reads). Opened
 * with `bun:sqlite` because the dashboard runs under the Bun runtime
 * (`bun --bun run`), which lets us reuse the CLI's tested repo layer and the
 * `loadWallets()` privacy indirection without a second driver.
 *
 * One process-wide connection, reused across requests. `busy_timeout` lets a
 * read wait out the CLI's short (≤200-row) write transactions instead of
 * erroring SQLITE_BUSY. `data/` stays writable on disk so SQLite can map the
 * `-wal`/`-shm` sidecars even from this readonly handle.
 */
const DB_PATH = process.env.DB_PATH ?? '../../data/liquidity-tax.db';

declare global {
  // eslint-disable-next-line no-var
  var __ltDashboardDb: ReturnType<typeof openReadonly> | undefined;
}

function openReadonly() {
  const sqlite = new Database(DB_PATH, { readonly: true });
  sqlite.exec('PRAGMA busy_timeout = 5000');
  return drizzle(sqlite, { schema });
}

// Survive Next dev hot-reload without leaking handles.
export const db = globalThis.__ltDashboardDb ?? openReadonly();
if (process.env.NODE_ENV !== 'production') globalThis.__ltDashboardDb = db;

export type DashboardDb = typeof db;
