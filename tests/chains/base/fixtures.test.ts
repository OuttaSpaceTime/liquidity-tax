import { describe, expect, test } from 'bun:test';
import { createTestDb } from '../../helpers/db';
import { createDefaultRegistry } from '../../../src/decoder';
import { rawTxs } from '../../../db/schema';
import { BASE_FIXTURES_DIR, listFixtureFiles, loadBaseFixture } from '../../helpers/fixtures';

/**
 * Golden-fixture tests for the Base protocol handlers (issue #4, [1A.0]).
 *
 * Each fixture under tests/fixtures/base/ is a REAL on-chain Base tx (raw tx +
 * receipt + logs as ingested) with a hand-labeled `expectedEvents: TaxEvent[]`.
 * Committed BEFORE the handlers exist — these tests are the failing artifact
 * the uniswap_v3 / aerodrome / aave_v3 handler issues implement against
 * (mirror: rotki rotkehlchen/tests/unit/decoders/test_aerodrome.py).
 *
 * Fixture conventions:
 * - `foreign: true` marks txs from other users (protocol absent from own history).
 * - amounts are decimal strings (JSON has no bigint); revived via BigInt().
 * - `expectedEvents` omit `handlerVersion` (handlers version independently);
 *   every other TaxEvent field present in the fixture must match exactly.
 * - asset naming: token symbol (WETH, USDC, AERO, ...) — matches the
 *   positions/eur-price test conventions and the Koinly export target.
 */

const files = listFixtureFiles(BASE_FIXTURES_DIR);

describe('base golden fixtures (hand-labeled real txs — RED until 1A handlers land)', () => {
  test('covers ≥3 fixtures each for uniswap_v3, aerodrome, aave_v3', () => {
    const byProtocol = new Map<string, number>();
    for (const file of files) {
      const fixture = loadBaseFixture(file);
      byProtocol.set(fixture.protocol, (byProtocol.get(fixture.protocol) ?? 0) + 1);
    }
    expect(byProtocol.get('uniswap_v3') ?? 0).toBeGreaterThanOrEqual(3);
    expect(byProtocol.get('aerodrome') ?? 0).toBeGreaterThanOrEqual(3);
    expect(byProtocol.get('aave_v3') ?? 0).toBeGreaterThanOrEqual(3);
  });

  for (const file of files) {
    const fixture = loadBaseFixture(file);

    test(`${file} (${fixture.protocol}${fixture.foreign ? ', foreign' : ''}): decodes to the hand-labeled TaxEvent[]`, () => {
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

      const registry = createDefaultRegistry(db, { wallets: { base: fixture.walletsContext } });
      const result = registry.decodeAndPersist('base', fixture.txHash);

      expect(result.status).toBe(fixture.expectedStatus ?? 'decoded');
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
});
