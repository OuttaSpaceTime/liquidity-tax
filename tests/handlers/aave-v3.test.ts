import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb } from '../helpers/db';
import { DecoderRegistry } from '../../src/decoder';
import { rawTxs } from '../../db/schema';
import { AaveV3Handler } from '../../src/handlers/aave-v3';
import type { BaseRawJson } from '../../src/chains/base/raw-json';
import type { TaxEvent } from '../../src/types/event';

/**
 * Aave V3 handler tests ([1A.5], issue #9) — golden fixtures are REAL Base txs
 * under tests/fixtures/base/aave_v3-*.json, hand-labeled before the handler
 * existed (locked test-first rule). All five fixtures are foreign (other
 * users' txs — own Base history has no first-person Aave positions) and cover
 * every decoded Pool event: Supply, Withdraw, Borrow, Repay, and
 * LiquidationCall (which must emit BOTH a collateral_seized and a debt_repaid
 * row — issue #9 done-when).
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
  .filter((f) => f.startsWith('aave_v3-') && f.endsWith('.json'))
  .sort();

/** Registry with ONLY the real aave_v3 handler (full registration happens in the Integrate phase). */
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
  registry.registerHandler(new AaveV3Handler());
  return registry.decodeAndPersist('base', fixture.txHash);
}

describe('aave_v3 handler — golden fixtures (real Base txs)', () => {
  test('covers all five Pool ops: supply, withdraw, borrow, repay, liquidation', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
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
        // Strict flags: hand-labels omitting `flags` mean NO flags — spurious
        // handler flags directly drive tax treatment and must fail here.
        expect(actual.flags ?? []).toEqual(fields.flags ?? []);
        if (sentAmount !== undefined) expect(actual.sentAmount).toBe(BigInt(sentAmount));
        if (receivedAmount !== undefined) {
          expect(actual.receivedAmount).toBe(BigInt(receivedAmount));
        }
      }
    });
  }

  test('liquidation fixture emits BOTH seized + repaid rows (issue #9 done-when)', () => {
    const result = decodeFixture(loadFixture('aave_v3-05-liquidation-foreign.json'));
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') return;
    expect(result.events.map((e) => `${e.type}:${e.subtype}`)).toEqual([
      'liquidation:collateral_seized',
      'liquidation:debt_repaid',
    ]);
  });

  test('never emits lend_interest (reserved type — claim-time policy, issue #9 done-when)', () => {
    for (const file of files) {
      const result = decodeFixture(loadFixture(file));
      expect(result.status).toBe('decoded');
      if (result.status !== 'decoded') continue;
      expect(result.events.some((e) => e.type === 'lend_interest')).toBe(false);
    }
  });

  test('skips Pool events whose user is not an owner wallet (aggregator-wrapper case)', () => {
    // Decode the supply fixture with a wallets context that does NOT contain
    // the Pool user: this models Felix's own aggregator swaps that route
    // through Aave wrappers (fixture 01 notes) — the handler must stay silent
    // (skip), leaving the tx to the swap handlers / generic rules.
    const fixture = loadFixture('aave_v3-01-supply.json');
    const result = decodeFixture(fixture, ['0x000000000000000000000000000000000000dead']);
    expect(result.status).toBe('skipped');
  });

  test('does not match a non-Aave tx (uniswap_v3 fixture)', () => {
    const handler = new AaveV3Handler();
    const fixture = loadFixture('uniswap_v3-01-open-position-mint.json');
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
