import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findWhirlpoolInstructions } from '../../../src/chains/solana/whirlpool-scan';
import { createDefaultRegistry } from '../../../src/decoder';
import type { RawTx } from '../../../src/decoder/types';
import type { TaxEvent } from '../../../src/types/event';
import { createTestDb } from '../../helpers/db';

/**
 * [1B.4] Solana golden-fixture tests — hand-labeled real Orca Whirlpool txs.
 *
 * Layout mirrors `onchain/rotki/rotkehlchen/tests/unit/decoders/test_*.py`
 * (real tx + hand-written expected events) and
 * `onchain/solana-tx-parser-public/tests/parseDlnSrcTransaction.test.ts`
 * (recorded raw JSON + expected decoded output).
 *
 * Test-first artifact: these assertions were written BEFORE the [1B.3]
 * handler exists. While `orca_whirlpool` is still the version-0 stub the
 * golden block is skipped (run `SOLANA_GOLDEN=force bun test` to see the RED
 * state); it activates automatically once a real handler claims the txs.
 */

const FIXTURE_DIR = join(import.meta.dir, '../../fixtures/solana');

interface GoldenExpectedEvent {
  type: TaxEvent['type'];
  subtype: string;
  logIndex: number;
  emissionSeq: number;
  timestamp: number;
  wallet: string;
  sentAsset?: string;
  sentAmount?: string;
  receivedAsset?: string;
  receivedAmount?: string;
  positionId?: string;
  flags?: string[];
}

interface GoldenFixture {
  txHash: string;
  /** 'own' = wallet history; 'foreign' = real on-chain tx from another user (case absent from own history). */
  source: 'own' | 'foreign';
  case: string;
  notes: string;
  wallet: string;
  expectedEvents: GoldenExpectedEvent[];
}

interface GoldenFile {
  conventions: Record<string, unknown>;
  fixtures: GoldenFixture[];
}

const golden = JSON.parse(
  readFileSync(join(FIXTURE_DIR, 'whirlpool-golden.json'), 'utf8'),
) as GoldenFile;

function loadRawTx(txHash: string): RawTx {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, 'raw', `${txHash}.json`), 'utf8')) as RawTx;
}

/** Common projection shape for hand-labeled vs produced events. */
interface ComparableEvent {
  type: string;
  subtype: string;
  logIndex: number;
  emissionSeq: number;
  timestamp: number;
  wallet: string;
  sentAsset: string | undefined;
  sentAmount: bigint | undefined;
  receivedAsset: string | undefined;
  receivedAmount: bigint | undefined;
  positionId: string | undefined;
  flags: string[] | undefined;
}

/** Comparable projection: full TaxEvent minus handler identity/versioning noise. */
function comparable(event: TaxEvent): ComparableEvent {
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

function expectedComparable(event: GoldenExpectedEvent): ComparableEvent {
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

function makeRegistry(wallets: readonly string[]) {
  const { db } = createTestDb();
  return createDefaultRegistry(db, { wallets: { solana: [...wallets] } });
}

/**
 * Probe: is the orca_whirlpool handler still the version-0 stub? The stub
 * never matches, so a known Whirlpool tx decodes to 'unclassified' with the
 * stub/no-handler reason. Once [1B.3] lands, the probe decodes and the golden
 * block below activates automatically.
 */
function orcaHandlerImplemented(): boolean {
  const raw = loadRawTx(golden.fixtures[0].txHash);
  const result = makeRegistry([golden.fixtures[0].wallet]).decode(raw);
  return !(
    result.status === 'unclassified' &&
    /handler not implemented|no handler matched/.test(result.reason)
  );
}

describe('solana whirlpool fixture integrity', () => {
  it('covers at least 10 hand-labeled fixtures', () => {
    expect(golden.fixtures.length).toBeGreaterThanOrEqual(10);
  });

  for (const [i, fixture] of golden.fixtures.entries()) {
    it(`fixture #${i} (${fixture.case}) has a raw tx with Whirlpool instructions and labels`, () => {
      const raw = loadRawTx(fixture.txHash);
      expect(raw.chain).toBe('solana');
      expect(raw.txHash).toBe(fixture.txHash);
      expect(raw.blockTimestamp).toBeGreaterThan(0);
      // A position-NFT-transfer fixture (no Whirlpool ix) does not exist in this
      // history — see conventions.notCovered in whirlpool-golden.json.
      expect(findWhirlpoolInstructions(raw.rawJson).length).toBeGreaterThan(0);
      expect(fixture.expectedEvents.length).toBeGreaterThan(0);
      for (const event of fixture.expectedEvents) {
        expect(event.timestamp).toBe(raw.blockTimestamp);
      }
    });
  }
});

const run = orcaHandlerImplemented() || process.env.SOLANA_GOLDEN === 'force';

describe.skipIf(!run)('orca whirlpool golden fixtures [1B.3]/[1B.4]', () => {
  for (const [i, fixture] of golden.fixtures.entries()) {
    it(`#${i} ${fixture.case} (${fixture.source})`, () => {
      const raw = loadRawTx(fixture.txHash);
      const registry = makeRegistry([fixture.wallet]);
      const result = registry.decode(raw);

      expect(result.status).toBe('decoded');
      if (result.status !== 'decoded') return;
      // Deterministic order: registry already sorts by (txHash, logIndex, emissionSeq).
      expect(result.events.map(comparable)).toEqual(
        fixture.expectedEvents.map(expectedComparable),
      );
      for (const event of result.events) {
        expect(event.handlerId).toBe('orca_whirlpool');
        expect(event.chain).toBe('solana');
        expect(event.txHash).toBe(fixture.txHash);
      }
    });
  }
});
