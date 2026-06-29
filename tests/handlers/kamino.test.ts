import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DecoderRegistry } from '../../src/decoder';
import type { RawTx } from '../../src/decoder/types';
import { kaminoHandler } from '../../src/handlers/kamino';
import type { TaxEvent } from '../../src/types/event';
import { createTestDb } from '../helpers/db';

/**
 * Kamino Lend (KLend) handler tests (WS3), driven by hand-labeled golden
 * fixtures of REAL Solana txs (tests/fixtures/solana/kamino-golden.json + raw
 * payloads under raw/). Kamino is an Anchor program with no Codama client, so
 * instructions are identified by their 8-byte discriminator and the actual
 * amounts/mints come from the adjacent SPL transfer CPI leg — mirroring the
 * orca-whirlpool approach. Coverage:
 *   01 supply native SOL collateral (wSOL leg, ephemeral ATA)
 *   02 withdraw SOL collateral
 *   03 borrow USDC
 *   04 leveraged loop (flash loan + embedded swaps) -> manual queue
 *   05 account-setup only (InitUserMetadata) -> skipped
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
  expectedStatus?: 'decoded' | 'unclassified' | 'skipped';
  expectedEvents: GoldenExpectedEvent[];
}

const golden = JSON.parse(readFileSync(join(FIXTURE_DIR, 'kamino-golden.json'), 'utf8')) as {
  fixtures: GoldenFixture[];
};

function loadRawTx(txHash: string): RawTx {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, 'raw', `${txHash}.json`), 'utf8')) as RawTx;
}

function makeRegistry(wallets: readonly string[]): DecoderRegistry {
  const { db } = createTestDb();
  const registry = new DecoderRegistry(db, { wallets: { solana: [...wallets] } });
  registry.registerHandler(kaminoHandler);
  return registry;
}

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

describe('kamino lend handler (WS3)', () => {
  it('is a real handler (version > 0, solana, id kamino)', () => {
    expect(kaminoHandler.id).toBe('kamino');
    expect(kaminoHandler.chain).toBe('solana');
    expect(kaminoHandler.version).toBeGreaterThan(0);
  });

  it('matches every Kamino fixture tx (KLend program present)', () => {
    for (const fixture of golden.fixtures) {
      expect(kaminoHandler.matches(loadRawTx(fixture.txHash))).toBe(true);
    }
  });

  for (const [i, fixture] of golden.fixtures.entries()) {
    it(`#${i} ${fixture.case} (${fixture.source})`, () => {
      const result = makeRegistry([fixture.wallet]).decode(loadRawTx(fixture.txHash));
      const expectedStatus = fixture.expectedStatus ?? 'decoded';
      expect(result.status).toBe(expectedStatus);
      if (result.status !== 'decoded') return;
      expect(result.events.map(comparable)).toEqual(fixture.expectedEvents.map(expectedComparable));
      for (const event of result.events) {
        expect(event.handlerId).toBe('kamino');
        expect(event.chain).toBe('solana');
        expect(event.txHash).toBe(fixture.txHash);
      }
    });
  }

  it('skips a Kamino tx where no configured wallet is involved', () => {
    const fixture = golden.fixtures.find((f) => f.expectedStatus !== 'skipped')!;
    const result = makeRegistry(['Unre1atedWa11etPubkey111111111111111111111']).decode(
      loadRawTx(fixture.txHash),
    );
    expect(result.status).toBe('skipped');
  });
});
