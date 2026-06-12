import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { openDb } from '../../src/db/client';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'liquidity-tax-db-client-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('openDb', () => {
  it('sets busy_timeout to 5000 ms for concurrent writers', () => {
    const client = openDb(join(dir, 'pragmas.db'));
    try {
      const row = client.sqlite.query<{ timeout: number }, []>('PRAGMA busy_timeout').get();
      expect(row?.timeout).toBe(5000);
    } finally {
      client.close();
    }
  });

  it('enforces foreign keys on every connection', () => {
    const client = openDb(join(dir, 'fk.db'));
    try {
      client.sqlite.exec(
        'CREATE TABLE parent (id INTEGER PRIMARY KEY);' +
          'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));',
      );
      expect(() => client.sqlite.exec('INSERT INTO child (parent_id) VALUES (999)')).toThrow(
        /FOREIGN KEY constraint failed/,
      );
    } finally {
      client.close();
    }
  });

  it('returns a drizzle handle bound to the same connection', () => {
    const client = openDb(join(dir, 'drizzle.db'));
    try {
      client.sqlite.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('hello')");
      const rows = client.db.all<{ v: string }>(sql`SELECT v FROM t`);
      expect(rows).toEqual([{ v: 'hello' }]);
    } finally {
      client.close();
    }
  });

  it('close() releases the connection — further queries throw', () => {
    const client = openDb(join(dir, 'close.db'));
    client.close();
    expect(() => client.sqlite.query('SELECT 1').get()).toThrow();
  });
});
