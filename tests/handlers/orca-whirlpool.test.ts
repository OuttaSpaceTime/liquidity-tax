import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DecoderRegistry } from '../../src/decoder';
import type { RawTx } from '../../src/decoder/types';
import { orcaWhirlpoolHandler } from '../../src/handlers/orca-whirlpool';
import { groupEventsByPosition, reducePositionEvents } from '../../src/positions';
import type { TaxEvent } from '../../src/types/event';
import { createTestDb } from '../helpers/db';

/**
 * [1B.3] Orca Whirlpool handler tests, driven by the [1B.4] hand-labeled
 * golden fixtures (tests/fixtures/solana/whirlpool-golden.json). Unlike the
 * registry-level golden suite (tests/chains/solana/whirlpool-golden.test.ts,
 * which activates once the handler replaces its stub in
 * `createDefaultRegistry`), this suite registers the real handler directly so
 * it runs red-first regardless of foundation wiring.
 */

const FIXTURE_DIR = join(import.meta.dir, '../fixtures/solana');

interface GoldenExpectedEvent {
  type: TaxEvent['type'];
  subtype: TaxEvent['subtype'];
  logIndex: number;
  emissionSeq: number;
  timestamp: number;
  wallet: string;
  sentAsset?: string;
  sentAmount?: string;
  receivedAsset?: string;
  receivedAmount?: string;
  positionId?: TaxEvent['positionId'];
  flags?: TaxEvent['flags'];
}

interface GoldenFixture {
  txHash: string;
  source: 'own' | 'foreign';
  case: string;
  notes: string;
  wallet: string;
  expectedEvents: GoldenExpectedEvent[];
}

const golden = JSON.parse(readFileSync(join(FIXTURE_DIR, 'whirlpool-golden.json'), 'utf8')) as {
  fixtures: GoldenFixture[];
};

function loadRawTx(txHash: string): RawTx {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, 'raw', `${txHash}.json`), 'utf8')) as RawTx;
}

function makeRegistry(wallets: readonly string[]): DecoderRegistry {
  const { db } = createTestDb();
  const registry = new DecoderRegistry(db, { wallets: { solana: [...wallets] } });
  registry.registerHandler(orcaWhirlpoolHandler);
  return registry;
}

/** Full TaxEvent minus handler identity/versioning noise (same shape as the golden suite). */
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

function expectedComparable(event: GoldenExpectedEvent) {
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

function decodeFixture(fixture: GoldenFixture): TaxEvent[] {
  const result = makeRegistry([fixture.wallet]).decode(loadRawTx(fixture.txHash));
  expect(result.status).toBe('decoded');
  return result.status === 'decoded' ? result.events : [];
}

describe('orca whirlpool handler [1B.3]', () => {
  it('matches every golden fixture tx', () => {
    for (const fixture of golden.fixtures) {
      expect(orcaWhirlpoolHandler.matches(loadRawTx(fixture.txHash))).toBe(true);
    }
  });

  it('is a real handler (version > 0, solana, id orca_whirlpool)', () => {
    expect(orcaWhirlpoolHandler.id).toBe('orca_whirlpool');
    expect(orcaWhirlpoolHandler.chain).toBe('solana');
    expect(orcaWhirlpoolHandler.version).toBeGreaterThan(0);
  });

  for (const [i, fixture] of golden.fixtures.entries()) {
    it(`#${i} ${fixture.case} (${fixture.source})`, () => {
      const events = decodeFixture(fixture);
      expect(events.map(comparable)).toEqual(fixture.expectedEvents.map(expectedComparable));
      for (const event of events) {
        expect(event.handlerId).toBe('orca_whirlpool');
        expect(event.chain).toBe('solana');
        expect(event.txHash).toBe(fixture.txHash);
      }
    });
  }

  it('skips a Whirlpool tx where no configured wallet is involved', () => {
    const fixture = golden.fixtures[0];
    const raw = loadRawTx(fixture.txHash);
    expect(orcaWhirlpoolHandler.matches(raw)).toBe(true);
    // Registry configured with an unrelated wallet (not among the tx's account keys) — tx is not ours.
    const result = makeRegistry(['Unre1atedWa11etPubkey111111111111111111111']).decode(raw);
    expect(result.status).toBe('skipped');
  });
});

describe('orca whirlpool position tracker integration', () => {
  it('reduces fixtures #8 + #9 (same position: harvest, then decrease + close) to a closed snapshot', () => {
    // Fixture #8: two-position harvest; #9: single-sided decrease + close of
    // position 8eKMieua... 93s later — a cross-tx rebalance-style lifecycle.
    const events = [...decodeFixture(golden.fixtures[8]), ...decodeFixture(golden.fixtures[9])];
    const positionId = 'solana:orca_whirlpool:8eKMieuaZaybEDdPRyUDPzU1vSc7tyw27Mtufp9mMa5h';
    const groups = groupEventsByPosition(events);
    const snapshot = reducePositionEvents(positionId, groups.get(positionId) ?? []);

    expect(snapshot).toBeDefined();
    if (snapshot === undefined) return;
    expect(snapshot.chain).toBe('solana');
    expect(snapshot.protocol).toBe('orca_whirlpool');
    expect(snapshot.state.status).toBe('closed');
    expect(snapshot.closedAt).toBe(1763626749);
    // Open tx predates the fixture set — the reducer infers the open.
    expect(snapshot.state.inferredOpen).toBe(true);
    expect(snapshot.state.withdrawn).toEqual({
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: '5770558454',
    });
    expect(snapshot.state.feesCollected).toEqual({
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: '9969209',
      So11111111111111111111111111111111111111112: '58388605',
    });
  });

  it('every position-scoped event type reduces without unexpected-type warnings (fixtures #0 + #4)', () => {
    const events = [...decodeFixture(golden.fixtures[0]), ...decodeFixture(golden.fixtures[4])];
    for (const [positionId, group] of groupEventsByPosition(events)) {
      const snapshot = reducePositionEvents(positionId, group);
      expect(snapshot).toBeDefined();
      const warnings = snapshot?.state.warnings ?? [];
      expect(warnings.filter((w) => w.startsWith('unexpected_event_type'))).toEqual([]);
    }
  });
});
