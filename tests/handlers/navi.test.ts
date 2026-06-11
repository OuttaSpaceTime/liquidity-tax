import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DecoderRegistry } from '../../src/decoder';
import type { RawTx } from '../../src/decoder/types';
import { naviHandler } from '../../src/handlers/navi';
import type { TaxEvent } from '../../src/types/event';
import { createTestDb } from '../helpers/db';

/**
 * [1C.4] Navi handler tests, driven by the [1C.6] hand-labeled Sui golden
 * fixtures (tests/fixtures/sui/navi-*.json — real on-chain txs committed
 * before this handler existed). Like tests/handlers/orca-whirlpool.test.ts,
 * this suite registers the real handler directly into a fresh registry so it
 * runs red-first regardless of the `createDefaultRegistry` stub wiring (the
 * stub swap happens in the Integrate phase).
 */

const FIXTURE_DIR = join(import.meta.dir, '../fixtures/sui');

type FixtureEvent = Omit<
  TaxEvent,
  'sentAmount' | 'receivedAmount' | 'handlerVersion' | 'priceUsd'
> & {
  sentAmount?: string;
  receivedAmount?: string;
};

interface SuiFixture {
  chain: 'sui';
  protocol: string;
  scenario: string;
  txHash: string;
  foreign: boolean;
  notes: string;
  walletsContext: string[];
  blockNumber: number;
  raw: { timestampMs?: string | null } & Record<string, unknown>;
  expectedEvents: FixtureEvent[];
}

const NAVI_FIXTURES = [
  'navi-01-lst-flash-leverage-loop.json',
  'navi-02-liquidation.json',
  'navi-03-reward-claim-compound.json',
];

/** Sui fixtures owned by other handlers — the Navi handler must not claim them. */
const OTHER_SUI_FIXTURES = [
  'turbos-01-rebalance-close-collect.json',
  'turbos-02-open-zap-aggregator-swap.json',
  'suilend-01-borrow-claim-redeposit.json',
  'cross-01-suilend-claim-lst-redeem-swap.json',
];

function loadFixture(file: string): SuiFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as SuiFixture;
}

function toRawTx(fixture: SuiFixture): RawTx {
  return {
    chain: 'sui',
    txHash: fixture.txHash,
    blockNumber: fixture.blockNumber,
    blockTimestamp: Math.floor(Number(fixture.raw.timestampMs ?? 0) / 1000),
    rawJson: fixture.raw,
    fetchedAt: 0,
  };
}

function makeRegistry(wallets: readonly string[]): DecoderRegistry {
  const { db } = createTestDb();
  const registry = new DecoderRegistry(db, { wallets: { sui: [...wallets] } });
  registry.registerHandler(naviHandler);
  return registry;
}

/** Full TaxEvent minus handler-versioning noise (mirrors the orca suite). */
function comparable(event: TaxEvent) {
  return {
    type: event.type,
    subtype: event.subtype,
    logIndex: event.logIndex,
    emissionSeq: event.emissionSeq,
    timestamp: event.timestamp,
    wallet: event.wallet,
    sentAsset: event.sentAsset,
    sentAmount: event.sentAmount,
    receivedAsset: event.receivedAsset,
    receivedAmount: event.receivedAmount,
    positionId: event.positionId,
    flags: event.flags,
  };
}

function expectedComparable(event: FixtureEvent) {
  return {
    type: event.type,
    subtype: event.subtype,
    logIndex: event.logIndex,
    emissionSeq: event.emissionSeq,
    timestamp: event.timestamp,
    wallet: event.wallet,
    sentAsset: event.sentAsset,
    sentAmount: event.sentAmount === undefined ? undefined : BigInt(event.sentAmount),
    receivedAsset: event.receivedAsset,
    receivedAmount: event.receivedAmount === undefined ? undefined : BigInt(event.receivedAmount),
    positionId: event.positionId,
    flags: event.flags,
  };
}

describe('navi handler [1C.4]', () => {
  it('is a real handler (id navi, chain sui, version > 0)', () => {
    expect(naviHandler.id).toBe('navi');
    expect(naviHandler.chain).toBe('sui');
    expect(naviHandler.version).toBeGreaterThan(0);
  });

  it('matches every navi golden fixture tx', () => {
    for (const file of NAVI_FIXTURES) {
      expect(naviHandler.matches(toRawTx(loadFixture(file)))).toBe(true);
    }
  });

  it('does not match the turbos/suilend/cross sui fixtures', () => {
    for (const file of OTHER_SUI_FIXTURES) {
      expect(naviHandler.matches(toRawTx(loadFixture(file)))).toBe(false);
    }
  });

  for (const file of NAVI_FIXTURES) {
    const fixture = loadFixture(file);
    it(`${file} (${fixture.scenario}${fixture.foreign ? ', foreign' : ''}): decodes to the hand-labeled TaxEvent[]`, () => {
      const result = makeRegistry(fixture.walletsContext).decode(toRawTx(fixture));
      expect(result.status).toBe('decoded');
      if (result.status !== 'decoded') return;

      expect(result.events.map(comparable)).toEqual(fixture.expectedEvents.map(expectedComparable));
      for (const event of result.events) {
        expect(event.handlerId).toBe('navi');
        expect(event.chain).toBe('sui');
        expect(event.txHash).toBe(fixture.txHash);
      }
    });
  }

  it('skips a Navi tx where no configured wallet is involved', () => {
    // navi-02 decoded with an unrelated wallet set: real Navi activity, not ours.
    const fixture = loadFixture('navi-02-liquidation.json');
    const raw = toRawTx(fixture);
    expect(naviHandler.matches(raw)).toBe(true);
    const result = makeRegistry(['0x' + 'ab'.repeat(32)]).decode(raw);
    expect(result.status).toBe('skipped');
  });

  it('routes an owned liquidator side to the manual queue (unclassified, not silent)', () => {
    // Same real liquidation tx, but configured as if the BOT were our wallet:
    // liquidator-perspective decoding is out of scope, must not decode silently.
    const fixture = loadFixture('navi-02-liquidation.json');
    const raw = toRawTx(fixture);
    const liquidationEvent = (
      fixture.raw as { events: { type: string; parsedJson: { sender: string } }[] }
    ).events.find((e) => e.type.endsWith('::lending::LiquidationEvent'));
    expect(liquidationEvent).toBeDefined();
    const result = makeRegistry([liquidationEvent!.parsedJson.sender]).decode(raw);
    expect(result.status).toBe('unclassified');
  });
});
