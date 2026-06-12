import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { loadWallets } from '../src/config/wallets-loader';
import { createTmpFileDb, runCli } from './helpers/cli';

/**
 * Root-CLI command wiring, exercised end-to-end as a subprocess against a
 * migrated temp DB (`DB_PATH` override). No network: only error paths,
 * empty-DB runs, and help output are exercised.
 *
 * Privacy: wallet-dependent cases assert on counts/labels only and are
 * skipped when no local wallet config resolves (e.g. fresh clone).
 */

let tmp: ReturnType<typeof createTmpFileDb>;
// Real (gitignored) wallet config present? Only used to skip; never printed.
const walletsAvailable = await loadWallets().then(
  () => true,
  () => false,
);

beforeAll(() => {
  tmp = createTmpFileDb();
});
afterAll(() => tmp.cleanup());

describe('liquidity-tax CLI', () => {
  it('wires ingest, decode, prices, link, and status commands into --help', () => {
    const res = runCli(['--help'], tmp.dbPath);
    expect(res.exitCode).toBe(0);
    for (const cmd of ['ingest', 'decode', 'prices', 'link', 'status']) {
      expect(res.stdout).toContain(cmd);
    }
  });

  it('status reports empty per-chain counts and zero table totals on a fresh DB', () => {
    const res = runCli(['status'], tmp.dbPath);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('raw_txs');
    expect(res.stdout).toContain('(empty)');
    for (const table of ['positions', 'prices', 'rules', 'transfer_links']) {
      expect(res.stdout).toContain(`${table.padEnd(14)} (total 0)`);
    }
  });

  it('ingest rejects an unknown chain with the expected-chains message', () => {
    const res = runCli(['ingest', '--chain', 'dogecoin'], tmp.dbPath);
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain("Unknown chain 'dogecoin'");
    expect(res.output).toContain('base, solana, sui');
  });

  it.skipIf(!walletsAvailable)(
    'ingest errors out when no active wallet matches the label filter',
    () => {
      const res = runCli(
        ['ingest', '--chain', 'base', '--label', '__no_such_label__'],
        tmp.dbPath,
      );
      expect(res.exitCode).not.toBe(0);
      expect(res.output).toContain('No active base wallets match the given filter.');
    },
  );

  it.skipIf(!walletsAvailable)(
    'decode runs the full registry + positions rebuild over an empty raw_txs table',
    () => {
      const res = runCli(['decode'], tmp.dbPath);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain(
        'decode: 0 txs → 0 decoded (0 events), 0 skipped, 0 unclassified',
      );
      expect(res.stdout).toContain('positions: 0 rebuilt, 0 stale removed');
    },
  );

  it('link reports zero candidates and writes nothing on an empty DB', () => {
    const res = runCli(['link'], tmp.dbPath);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('0 sends × 0 receives considered');
    expect(res.stdout).toContain('0 links written');
  });

  it('link --dry-run is labeled as such', () => {
    const res = runCli(['link', '--dry-run'], tmp.dbPath);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('link (dry run):');
  });

  it('prices backfill rejects a non-positive --max-calls before touching anything', () => {
    const res = runCli(['prices', 'backfill', '--max-calls', '0'], tmp.dbPath);
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain("--max-calls must be a positive integer, got '0'");
  });

  it('prices backfill completes with zero API calls on an empty events table', () => {
    // Fake key masks any real one (dotenv never overrides); no pairs → no calls.
    const res = runCli(['prices', 'backfill'], tmp.dbPath, {
      COINGECKO_API_KEY: 'test-key-unused',
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('backfill: 0 pairs needed');
    expect(res.stdout).toContain('0 rows written');
    expect(res.stdout).toContain('(0 coingecko + 0 defillama calls, completed)');
  });

  it('prices import-eur-cache reads the given path and reports an empty cache', () => {
    const cachePath = tmp.writeFile('empty-eur-cache.json', '{}');
    const res = runCli(['prices', 'import-eur-cache', cachePath], tmp.dbPath);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('import: 0 cached pairs across 0 coins → 0 rows written');
    expect(res.stdout).toContain('(0 defillama calls)');
  });
});
