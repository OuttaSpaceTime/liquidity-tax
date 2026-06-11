import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb } from '../helpers/db';
import { DecoderRegistry } from '../../src/decoder';
import { rawTxs } from '../../db/schema';
import { AerodromeHandler } from '../../src/handlers/aerodrome';
import { groupEventsByPosition, reducePositionEvents } from '../../src/positions';
import type { BaseRawJson } from '../../src/chains/base/ingest';
import type { TaxEvent } from '../../src/types/event';

/**
 * Aerodrome handler tests ([1A.4], issue #8) — golden fixtures are REAL Base
 * txs under tests/fixtures/base/aerodrome-*.json, hand-labeled before the
 * handler existed (locked test-first rule). Coverage:
 *
 *  01  vfat Sickle zap add_liquidity (ETH wrap + pool swap via intermediary
 *      executor + NPM IncreaseLiquidity, all custody on the Sickle proxy)
 *  02  vfat Sickle full rebalance (fee collect + principal decrease+collect+
 *      burn for one tokenId — the two-Collect split — plus fee/principal
 *      skims, swap through TWO intermediaries, and a fresh position mint)
 *  03  vfat Sickle fee-only harvest (gross lp_fee legs + skim transfer:send,
 *      Sickle->EOA net forward suppressed)
 *  04  direct AERO gauge claim (lp_reward:gauge_claim at the ClaimRewards log)
 *  05  gauge stake of the position NFT — emits NOTHING (status skipped)
 *  06  Sickle-proxied gauge claim: gross lp_reward + AERO skim transfer:send
 *  07  gauge unstake + final claim: only lp_reward; zero-amount NPM Collect
 *      must not trip the all-legs-zero unclassified path
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
  expectedStatus?: 'decoded' | 'skipped';
  raw: BaseRawJson;
  expectedEvents: FixtureEvent[];
}

function loadFixture(file: string): BaseFixture {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')) as BaseFixture;
}

const files = readdirSync(FIXTURES_DIR)
  .filter((f) => f.startsWith('aerodrome-') && f.endsWith('.json'))
  .sort();

/** Registry with ONLY the real aerodrome handler (default registry holds the stub until Integrate). */
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
  registry.registerHandler(new AerodromeHandler());
  return registry.decodeAndPersist('base', fixture.txHash);
}

describe('aerodrome handler — golden fixtures (real Base txs)', () => {
  test('covers Sickle LP lifecycle + gauge ops: 7 fixtures', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  for (const file of files) {
    const fixture = loadFixture(file);
    const expectedStatus = fixture.expectedStatus ?? 'decoded';
    test(`${file}${fixture.foreign ? ' (foreign)' : ''}: decodes to the hand-labeled outcome`, () => {
      const result = decodeFixture(fixture);

      expect(result.status).toBe(expectedStatus);
      if (result.status !== 'decoded') return;

      expect(result.events).toHaveLength(fixture.expectedEvents.length);
      for (const [i, expected] of fixture.expectedEvents.entries()) {
        const actual = result.events[i]!;
        const { sentAmount, receivedAmount, ...fields } = expected;
        expect(actual).toMatchObject(fields as Record<string, unknown>);
        if (sentAmount !== undefined) expect(actual.sentAmount).toBe(BigInt(sentAmount));
        if (receivedAmount !== undefined) {
          expect(actual.receivedAmount).toBe(BigInt(receivedAmount));
        }
      }
    });
  }

  test('does not match a non-Aerodrome tx (aave_v3 supply, uniswap_v3 NPM mint)', () => {
    const handler = new AerodromeHandler();
    for (const file of ['aave_v3-01-supply.json', 'uniswap_v3-01-open-position-mint.json']) {
      const fixture = loadFixture(file);
      const raw = {
        chain: 'base',
        txHash: fixture.txHash,
        blockNumber: fixture.blockNumber,
        blockTimestamp: fixture.raw.blockTimestamp,
        rawJson: fixture.raw,
        fetchedAt: 0,
      };
      expect(handler.matches(raw as never)).toBe(false);
    }
  });
});

describe('aerodrome handler — position tracker integration (src/positions)', () => {
  test('rebalance fixture: closes 29372936 (principal+fees split) and opens 30347282 in one tx', () => {
    const result = decodeFixture(loadFixture('aerodrome-02-sickle-full-rebalance.json'));
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') return;

    const groups = groupEventsByPosition(result.events);

    const closed = reducePositionEvents(
      'base:aerodrome:29372936',
      groups.get('base:aerodrome:29372936')!,
    )!;
    expect(closed.state.status).toBe('closed');
    expect(closed.state.withdrawn).toEqual({
      WETH: '846239421182204187',
      USDC: '2167215498',
    });
    expect(closed.state.feesCollected).toEqual({
      WETH: '1509127850442198',
      USDC: '5602574',
    });

    const opened = reducePositionEvents(
      'base:aerodrome:30347282',
      groups.get('base:aerodrome:30347282')!,
    )!;
    expect(opened.state.status).toBe('open');
    expect(opened.state.inferredOpen).toBe(false);
    expect(opened.state.deposited).toEqual({
      WETH: '1210149655100525624',
      USDC: '761434232',
    });
  });
});
