import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWallets, walletsFor } from '../../src/config/wallets-loader';

// All addresses below are synthetic test fixtures, never real wallets.
let dir: string;
let validPath: string;
let validStagedPath: string;
let invalidShapePath: string;
let noExportPath: string;
const missingPath = '/nonexistent/wallets.ts';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wallets-loader-test-'));
  validPath = join(dir, 'wallets.ts');
  writeFileSync(
    validPath,
    `export const WALLETS = [
      { chain: 'base', address: '0xSYNTHETIC_A', label: 'rabby', status: 'active' },
      { chain: 'base', address: '0xSYNTHETIC_B', label: 'base-main-sickle', status: 'archived' },
      { chain: 'solana', address: 'SYNTHETIC_C', label: 'phantom', status: 'active' },
      { chain: 'sui', address: '0xSYNTHETIC_D', label: 'phantom-sui', status: 'active' },
    ];`,
  );
  validStagedPath = join(dir, 'wallets.staged.ts');
  writeFileSync(
    validStagedPath,
    `export const WALLETS = [
      { chain: 'sui', address: '0xSYNTHETIC_STAGED', label: 'staged-only', status: 'active' },
    ];`,
  );
  invalidShapePath = join(dir, 'wallets.invalid.ts');
  writeFileSync(
    invalidShapePath,
    `export const WALLETS = [{ chain: 'bitcoin', address: '0xSYNTHETIC_BAD', label: 'x', status: 'active' }];`,
  );
  noExportPath = join(dir, 'wallets.noexport.ts');
  writeFileSync(noExportPath, `export const notWallets = 42;`);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('wallets loader', () => {
  it('loads a valid WALLETS array from the first candidate', async () => {
    const wallets = await loadWallets([validPath, validStagedPath]);
    expect(wallets).toHaveLength(4);
    expect(wallets[0].label).toBe('rabby');
  });

  it('falls back to the staged candidate when the first is missing', async () => {
    const wallets = await loadWallets([missingPath, validStagedPath]);
    expect(wallets).toHaveLength(1);
    expect(wallets[0].label).toBe('staged-only');
  });

  it('falls back when the first candidate fails zod validation', async () => {
    const wallets = await loadWallets([invalidShapePath, validStagedPath]);
    expect(wallets[0].label).toBe('staged-only');
  });

  it('falls back when the first candidate has no WALLETS export', async () => {
    const wallets = await loadWallets([noExportPath, validStagedPath]);
    expect(wallets[0].label).toBe('staged-only');
  });

  it('throws when no candidate yields a valid array — without leaking addresses', async () => {
    let err: Error | undefined;
    try {
      await loadWallets([missingPath, invalidShapePath]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).not.toContain('SYNTHETIC');
  });

  it('walletsFor filters by chain with status defaulting to active', async () => {
    const base = await walletsFor('base', undefined, [validPath]);
    expect(base).toHaveLength(1);
    expect(base[0].label).toBe('rabby');
  });

  it('walletsFor can select archived or all statuses', async () => {
    const archived = await walletsFor('base', 'archived', [validPath]);
    expect(archived.map((w) => w.label)).toEqual(['base-main-sickle']);
    const all = await walletsFor('base', 'all', [validPath]);
    expect(all).toHaveLength(2);
  });
});
