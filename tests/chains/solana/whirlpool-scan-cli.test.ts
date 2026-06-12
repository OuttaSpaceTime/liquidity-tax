import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from '../../../db/schema';
import { upsertRawTxs, type RawTxInsert } from '../../../src/db/repos/raw-txs';
import { createTmpFileDb, runScript, PROJECT_ROOT } from '../../helpers/cli';

/**
 * `whirlpool-scan` CLI entry ([1B.4] fixture-selection aid): scans
 * raw_txs(chain=solana) and prints a per-tx instruction summary + histogram.
 * Exercised as a subprocess against a temp DB seeded from a committed raw
 * fixture (real on-chain tx; hash is committed data, safe to print).
 */

const SCRIPT = 'src/chains/solana/whirlpool-scan.ts';
const RAW_DIR = join(PROJECT_ROOT, 'tests/fixtures/solana/raw');

let empty: ReturnType<typeof createTmpFileDb>;
let seeded: ReturnType<typeof createTmpFileDb>;
let seededRow: RawTxInsert;

beforeAll(() => {
  empty = createTmpFileDb();
  seeded = createTmpFileDb();

  const fixtureFile = readdirSync(RAW_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()[0]!;
  seededRow = JSON.parse(readFileSync(join(RAW_DIR, fixtureFile), 'utf8')) as RawTxInsert;
  const sqlite = new Database(seeded.dbPath);
  try {
    upsertRawTxs(drizzle(sqlite, { schema }), [seededRow]);
  } finally {
    sqlite.close();
  }
});
afterAll(() => {
  empty.cleanup();
  seeded.cleanup();
});

describe('whirlpool-scan CLI', () => {
  it('reports zero Whirlpool activity on an empty DB', () => {
    const res = runScript(SCRIPT, [], empty.dbPath);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('0 solana txs, 0 touch Whirlpool');
  });

  it('identifies Whirlpool instructions of a stored raw tx and prints the histogram', () => {
    const res = runScript(SCRIPT, [], seeded.dbPath);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('1 solana txs, 1 touch Whirlpool');
    // Per-tx line: hash, UTC day, named instructions (Anchor discriminators).
    expect(res.stdout).toContain(seededRow.txHash);
    const day = new Date(seededRow.blockTimestamp * 1000).toISOString().slice(0, 10);
    expect(res.stdout).toContain(day);
    // Every golden raw fixture contains at least one identified Whirlpool ix.
    expect(res.stdout).toMatch(/ {2}\w+ +\d+\n/); // histogram row: name + count
    expect(res.stdout).not.toContain('unknown@');
  });
});
