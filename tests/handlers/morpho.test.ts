import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb } from '../helpers/db';
import { DecoderRegistry } from '../../src/decoder';
import { rawTxs } from '../../db/schema';
import { MorphoHandler } from '../../src/handlers/morpho';
import type { BaseRawJson } from '../../src/chains/base/ingest';
import type { TaxEvent } from '../../src/types/event';

/**
 * Morpho handler tests (task M1) — golden fixtures are REAL Base txs under
 * tests/fixtures/base/morpho-*.json, hand-labeled before the handler existed
 * (locked test-first rule). ALL seven fixtures are foreign: 2026-06-12 recon
 * found zero Morpho txs in own Base history (no Blue singleton, no bundlers,
 * no URD; the only ERC-4626 topic hits were Aave waBas* wrappers inside
 * Balancer V3 swap routes — exactly the false positive the vault gate must
 * reject). Coverage: Bundler3-wrapped SupplyCollateral + Borrow, smart-account
 * Repay + WithdrawCollateral, MetaMorpho vault deposit/withdraw, URD reward
 * claim, and a Liquidate (dual-row).
 */

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/base/', import.meta.url));

type FixtureEvent = Omit<
  TaxEvent,
  'sentAmount' | 'receivedAmount' | 'handlerVersion' | 'priceUsd'
> & {
  sentAmount?: string;
  receivedAmount?: string;
};

interface BaseFixture {
  chain: 'base';
  protocol: string;
  txHash: string;
  foreign: boolean;
  notes: string;
  walletsContext: string[];
  blockNumber: number;
  raw: BaseRawJson;
  expectedEvents: FixtureEvent[];
}

function loadFixture(file: string): BaseFixture {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')) as BaseFixture;
}

const files = readdirSync(FIXTURES_DIR)
  .filter((f) => f.startsWith('morpho-') && f.endsWith('.json'))
  .sort();

/** Registry with ONLY the morpho handler (full registration is in src/handlers/index.ts). */
function decodeFixture(fixture: BaseFixture, wallets: string[] = fixture.walletsContext) {
  const { db } = createTestDb();
  db.insert(rawTxs)
    .values({
      chain: 'base',
      txHash: fixture.txHash,
      blockNumber: fixture.blockNumber,
      blockTimestamp: fixture.raw.blockTimestamp,
      rawJson: fixture.raw,
      fetchedAt: 0,
    })
    .run();
  const registry = new DecoderRegistry(db, { wallets: { base: wallets } });
  registry.registerHandler(new MorphoHandler());
  return registry.decodeAndPersist('base', fixture.txHash);
}

describe('morpho handler — golden fixtures (real Base txs, all foreign)', () => {
  test('covers blue collateral/borrow/repay/withdraw, vault deposit/withdraw, URD claim, liquidation', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  for (const file of files) {
    const fixture = loadFixture(file);
    test(`${file}${fixture.foreign ? ' (foreign)' : ''}: decodes to the hand-labeled TaxEvent[]`, () => {
      const result = decodeFixture(fixture);

      expect(result.status).toBe('decoded');
      if (result.status !== 'decoded') return;

      expect(result.events).toHaveLength(fixture.expectedEvents.length);
      for (const [i, expected] of fixture.expectedEvents.entries()) {
        const actual = result.events[i]!;
        const { sentAmount, receivedAmount, ...fields } = expected;
        expect(actual).toMatchObject(fields as Record<string, unknown>);
        // Strict flags: hand-labels omitting `flags` mean NO flags.
        expect(actual.flags ?? []).toEqual(fields.flags ?? []);
        if (sentAmount !== undefined) expect(actual.sentAmount).toBe(BigInt(sentAmount));
        if (receivedAmount !== undefined) {
          expect(actual.receivedAmount).toBe(BigInt(receivedAmount));
        }
      }
    });
  }

  test('liquidation fixture emits BOTH seized + repaid rows (aave dual-row convention)', () => {
    const result = decodeFixture(loadFixture('morpho-07-liquidation-foreign.json'));
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') return;
    expect(result.events.map((e) => `${e.type}:${e.subtype}`)).toEqual([
      'liquidation:collateral_seized',
      'liquidation:debt_repaid',
    ]);
  });

  test('vault deposit emits ONE event — the Blue Supply by the vault must not double-emit', () => {
    const result = decodeFixture(loadFixture('morpho-04-vault-deposit.json'));
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') return;
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.subtype).toBe('deposit');
  });

  test('never emits lend_interest (reserved type — interest recognized at withdrawal)', () => {
    for (const file of files) {
      const result = decodeFixture(loadFixture(file));
      expect(result.status).toBe('decoded');
      if (result.status !== 'decoded') continue;
      expect(result.events.some((e) => e.type === 'lend_interest')).toBe(false);
    }
  });

  test('skips events whose economic party is not an owner wallet (foreign-leg case)', () => {
    // Decode the bundler supply fixture with a wallets context that does NOT
    // contain onBehalf: the handler must stay silent (skip), leaving the tx
    // to swap handlers / generic rules — never attribute foreign positions.
    const fixture = loadFixture('morpho-01-supply-collateral-bundler.json');
    const result = decodeFixture(fixture, ['0x000000000000000000000000000000000000dead']);
    expect(result.status).toBe('skipped');
  });

  test('does not match a non-Morpho ERC-4626 tx (Aave waBas* wrapper in a swap route)', () => {
    // aave_v3-01 has Pool logs but no Blue singleton / URD logs; and the recon
    // waBas* swap shape (4626 Deposit without a Blue log naming the emitter as
    // onBehalf) must not be claimed by morpho.
    const handler = new MorphoHandler();
    const fixture = loadFixture('aave_v3-01-supply.json');
    const raw = {
      chain: 'base',
      txHash: fixture.txHash,
      blockNumber: fixture.blockNumber,
      blockTimestamp: fixture.raw.blockTimestamp,
      rawJson: fixture.raw,
      fetchedAt: 0,
    };
    expect(handler.matches(raw as never)).toBe(false);
  });
});
