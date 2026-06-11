import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb } from '../helpers/db';
import { DecoderRegistry } from '../../src/decoder';
import { rawTxs } from '../../db/schema';
import { UniswapV3Handler } from '../../src/handlers/uniswap-v3';
import { groupEventsByPosition, reducePositionEvents } from '../../src/positions';
import type { BaseRawJson } from '../../src/chains/base/ingest';
import type { TaxEvent } from '../../src/types/event';

/**
 * Uniswap V3 handler tests ([1A.3], issue #7) — golden fixtures are REAL Base
 * txs under tests/fixtures/base/uniswap_v3-*.json, hand-labeled before the
 * handler existed (locked test-first rule). The five fixtures cover every NPM
 * op: mint (open), increaseLiquidity (add), decreaseLiquidity+collect in one
 * tx (THE error-prone principal-vs-fee split), collect-only, and
 * decrease+collect+burn (close, with a fee-only token0 leg).
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
  .filter((f) => f.startsWith('uniswap_v3-') && f.endsWith('.json'))
  .sort();

/** Registry with ONLY the real uniswap_v3 handler (default registry still holds the stub until the Integrate phase swaps it). */
function decodeFixture(fixture: BaseFixture) {
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
  const registry = new DecoderRegistry(db, { wallets: { base: fixture.walletsContext } });
  registry.registerHandler(new UniswapV3Handler());
  return registry.decodeAndPersist('base', fixture.txHash);
}

describe('uniswap_v3 handler — golden fixtures (real Base txs)', () => {
  test('covers all five NPM ops: mint, increase, decrease+collect, collect-only, close+burn', () => {
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

  test('does not match a non-NPM tx (aave_v3 fixture)', () => {
    const handler = new UniswapV3Handler();
    const fixture = JSON.parse(
      readFileSync(join(FIXTURES_DIR, 'aave_v3-01-supply.json'), 'utf8'),
    ) as BaseFixture;
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

describe('uniswap_v3 handler — position tracker integration (src/positions)', () => {
  test('open fixture: tracker opens position 5311225 with both deposit legs', () => {
    const result = decodeFixture(loadFixture('uniswap_v3-01-open-position-mint.json'));
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') return;

    const groups = groupEventsByPosition(result.events);
    const snapshot = reducePositionEvents(
      'base:uniswap_v3:5311225',
      groups.get('base:uniswap_v3:5311225')!,
    )!;
    expect(snapshot.state.status).toBe('open');
    expect(snapshot.state.inferredOpen).toBe(false);
    expect(snapshot.state.deposited).toEqual({
      BRETT: '752235263045632476571513',
      WETH: '1910360338702338816',
    });
  });

  test('decrease+collect fixture: tracker splits principal (withdrawn) from fees (feesCollected)', () => {
    const result = decodeFixture(loadFixture('uniswap_v3-02-decrease-and-collect.json'));
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') return;

    const groups = groupEventsByPosition(result.events);
    const snapshot = reducePositionEvents(
      'base:uniswap_v3:5310929',
      groups.get('base:uniswap_v3:5310929')!,
    )!;
    expect(snapshot.state.status).toBe('open'); // no burn => still open
    expect(snapshot.state.withdrawn).toEqual({ USDC: '144443486' });
    expect(snapshot.state.feesCollected).toEqual({ CTR: '30192102343211020903', USDC: '406490' });
  });

  test('close fixture: tracker closes position 5312198 in the burn tx', () => {
    const result = decodeFixture(loadFixture('uniswap_v3-05-close-position-burn.json'));
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') return;

    const groups = groupEventsByPosition(result.events);
    const snapshot = reducePositionEvents(
      'base:uniswap_v3:5312198',
      groups.get('base:uniswap_v3:5312198')!,
    )!;
    expect(snapshot.state.status).toBe('closed');
    expect(snapshot.closedAt).toBe(1781167061);
    expect(snapshot.state.withdrawn).toEqual({ USDC: '17485894' });
    expect(snapshot.state.feesCollected).toEqual({ USDC: '5900', WETH: '3567265344603' });
    // history starts mid-lifecycle (no open in stream) => inferred open is the
    // ONLY warning; the collect trailing the close inside the closing tx must not warn
    expect(snapshot.state.inferredOpen).toBe(true);
    expect(snapshot.state.warnings).toEqual([
      'inferred_open:0x3f1377c9d7e9eafb7853f868bc911af2f6fe574b05f2b6fc382ab95a1f59b2d7',
    ]);
  });
});
