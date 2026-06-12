import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from '../../db/schema';

export const PROJECT_ROOT = new URL('../..', import.meta.url).pathname;

/**
 * Migrated SQLite database in a temp directory — for tests that spawn the CLI
 * as a subprocess (the CLI opens `DB_PATH` itself, so `:memory:` won't do).
 * Call `cleanup()` in `afterAll`.
 */
export function createTmpFileDb(): {
  dbPath: string;
  dir: string;
  writeFile: (name: string, content: string) => string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'liquidity-tax-cli-test-'));
  const dbPath = join(dir, 'test.db');
  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: join(PROJECT_ROOT, 'db/migrations') });
  sqlite.close();
  return {
    dbPath,
    dir,
    writeFile: (name: string, content: string): string => {
      const path = join(dir, name);
      writeFileSync(path, content);
      return path;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr — commander splits messages across both. */
  output: string;
}

/**
 * Run a project script (e.g. `src/cli.ts`) as a Bun subprocess against a temp
 * DB. `extraEnv` wins over `.env` (dotenv never overrides preset vars), so
 * fake API keys here safely mask real ones for no-network code paths.
 */
export function runScript(
  scriptPath: string,
  args: readonly string[],
  dbPath: string,
  extraEnv: Record<string, string> = {},
): CliResult {
  const proc = Bun.spawnSync([process.execPath, scriptPath, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DB_PATH: dbPath, ...extraEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  return { exitCode: proc.exitCode, stdout, stderr, output: stdout + stderr };
}

export function runCli(
  args: readonly string[],
  dbPath: string,
  extraEnv: Record<string, string> = {},
): CliResult {
  return runScript('src/cli.ts', args, dbPath, extraEnv);
}
