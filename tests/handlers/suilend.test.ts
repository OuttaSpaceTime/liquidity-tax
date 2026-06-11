import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DecoderRegistry } from '../../src/decoder';
import type { RawTx } from '../../src/decoder/types';
import { suilendHandler } from '../../src/handlers/suilend';
import type { TaxEvent } from '../../src/types/event';
import { createTestDb } from '../helpers/db';

/**
 * [1C.5] Suilend handler tests, driven by the [1C.6] hand-labeled golden
 * fixtures under tests/fixtures/sui/ (suilend-* plus the cross-protocol
 * cross-01 fixture, whose swap leg is pinned to handlerId 'suilend' by the
 * dominant-protocol convention). Unlike the registry-level golden suite
 * (tests/chains/sui/fixtures.test.ts, which activates once the integration
 * agent replaces the stubs in `createDefaultRegistry`), this suite registers
 * the real handler directly so it runs red-first regardless of foundation
 * wiring — same pattern as tests/handlers/orca-whirlpool.test.ts.
 */

const FIXTURES_DIR = join(import.meta.dir, '../fixtures/sui');

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

/** Every fixture whose hand-labeled events belong to the suilend handler. */
const files = readdirSync(FIXTURES_DIR)
  .filter((f) => f.startsWith('suilend-') || f.startsWith('cross-01'))
  .sort();

function loadFixture(file: string): SuiFixture {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')) as SuiFixture;
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
  registry.registerHandler(suilendHandler);
  return registry;
}

/** Full TaxEvent minus handler versioning noise (same shape as the golden suite). */
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
    flags: event.flags,
  };
}

describe('suilend handler [1C.5]', () => {
  it('is a real handler (version > 0, sui, id suilend)', () => {
    expect(suilendHandler.id).toBe('suilend');
    expect(suilendHandler.chain).toBe('sui');
    expect(suilendHandler.version).toBeGreaterThan(0);
  });

  it('matches every suilend golden fixture tx', () => {
    for (const file of files) {
      expect(suilendHandler.matches(toRawTx(loadFixture(file)))).toBe(true);
    }
  });

  for (const file of files) {
    const fixture = loadFixture(file);
    it(`${file} (${fixture.scenario}${fixture.foreign ? ', foreign' : ''}): decodes to the hand-labeled TaxEvent[]`, () => {
      const result = makeRegistry(fixture.walletsContext).decode(toRawTx(fixture));
      expect(result.status).toBe('decoded');
      if (result.status !== 'decoded') return;
      expect(result.events.map(comparable)).toEqual(
        fixture.expectedEvents.map(expectedComparable),
      );
      for (const event of result.events) {
        expect(event.handlerId).toBe('suilend');
        expect(event.chain).toBe('sui');
        expect(event.txHash).toBe(fixture.txHash);
      }
    });
  }

  it('skips a Suilend tx where no configured wallet is the sender', () => {
    const fixture = loadFixture(files[0]!);
    const raw = toRawTx(fixture);
    expect(suilendHandler.matches(raw)).toBe(true);
    const result = makeRegistry([
      '0x000000000000000000000000000000000000000000000000000000000000dead',
    ]).decode(raw);
    expect(result.status).toBe('skipped');
  });

  it('does not match a non-Suilend sui tx', () => {
    const turbos = readdirSync(FIXTURES_DIR).find((f) => f.startsWith('turbos-01'));
    expect(turbos).toBeDefined();
    expect(suilendHandler.matches(toRawTx(loadFixture(turbos!)))).toBe(false);
  });
});
