import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb } from '../helpers/db';
import { DecoderRegistry } from '../../src/decoder';
import { rawTxs } from '../../db/schema';
import { AerodromeHandler } from '../../src/handlers/aerodrome';
import { groupEventsByPosition, reducePositionEvents } from '../../src/positions';
import type { BaseRawJson } from '../../src/chains/base/raw-json';
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

describe('aerodrome handler — ownership gates (review regressions)', () => {
  // These two scenarios are absent from own history by construction (foreign
  // actor / keeper sender), so they are reproduced as in-memory variants of
  // the committed REAL fixtures instead of separate fixture files.
  const pad32 = (address: string): string => `0x${'0'.repeat(24)}${address.slice(2)}`;
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

  test("a third party's gauge claim batched with an unrelated incoming transfer is NOT our income", () => {
    const fixture = loadFixture('aerodrome-04-gauge-claim-direct.json');
    const me = '0x00000000000000000000000000000000000beef1';
    const stranger = '0x00000000000000000000000000000000000feed2';
    // The original claimer stays in the receipt; we merely receive an
    // unrelated USDC transfer in the same tx (why it landed in raw_txs).
    fixture.raw.receipt.logs.push({
      address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      topics: [TRANSFER_TOPIC, pad32(stranger), pad32(me)],
      data: '0x0000000000000000000000000000000000000000000000000000000005f5e100',
      logIndex: '0x7ff',
    });
    fixture.walletsContext = [me];
    (fixture.raw as { addresses?: string[] }).addresses = [me];

    const result = decodeFixture(fixture);
    // Foreign gauge activity: nothing of ours decodes — never lp_reward income.
    expect(result.status).toBe('skipped');
  });

  test('keeper-triggered Sickle harvest with no owner leg goes to the manual queue, not to the keeper', () => {
    const fixture = loadFixture('aerodrome-06-sickle-gauge-claim-skim.json');
    const keeper = '0x00000000000000000000000000000000000ca11e';
    fixture.raw.tx.from = keeper;
    // Remove the Sickle→EOA net forward (log 0x166): rewards stay in the
    // Sickle, so no configured wallet appears anywhere in the transfers.
    fixture.raw.receipt.logs = fixture.raw.receipt.logs.filter((log) => log.logIndex !== '0x166');

    const result = decodeFixture(fixture);
    expect(result.status).toBe('unclassified');
    if (result.status === 'unclassified') {
      expect(result.reason).toContain('owner');
    }
  });

  test('keeper-triggered Sickle add_liquidity attributes the lp_deposit to the OWNER, never the keeper', () => {
    // Review finding: with tx.from = keeper and a dust sweep Sickle→owner in
    // the same receipt (which defeats the no-owner-anywhere guard above), the
    // no-mint IncreaseLiquidity leg was attributed to the keeper EOA — the
    // re-deposit basis silently left the owner's position lifecycle. Variant
    // of the REAL aerodrome-01 zap (no keeper-sender tx exists in history).
    const fixture = loadFixture('aerodrome-01-sickle-zap-add-liquidity.json');
    const owner = fixture.walletsContext[0]!;
    const sickle = fixture.raw.addresses.find((a) => a !== owner)!;
    const keeper = '0x00000000000000000000000000000000000ca11e';
    fixture.raw.tx.from = keeper;
    fixture.raw.tx.value = '0x0'; // keeper calls carry no owner ETH (drops the raw-ETH vfat fee leg)
    // Dust sweep Sickle→owner (1 wei WETH): suppressed as internal, but it
    // makes the owner resolvable from the transfers — the exact scenario that
    // defeated the keeper guard.
    fixture.raw.receipt.logs.push({
      address: '0x4200000000000000000000000000000000000006',
      topics: [TRANSFER_TOPIC, pad32(sickle), pad32(owner)],
      data: '0x0000000000000000000000000000000000000000000000000000000000000001',
      logIndex: '0x7fe',
    });

    const result = decodeFixture(fixture);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') return;

    const deposits = result.events.filter((e) => e.type === 'lp_deposit');
    expect(deposits).toHaveLength(2); // WETH + USDC legs, as in the original fixture
    for (const event of result.events) {
      expect(event.wallet).toBe(owner);
    }
    // The owner-funded raw-ETH vfat fee must NOT be fabricated for a keeper call.
    expect(result.events.some((e) => e.sentAsset === 'ETH' && e.flags !== undefined)).toBe(false);
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
