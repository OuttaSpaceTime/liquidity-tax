import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { createTestDb } from '../../helpers/db';
import { createDefaultRegistry } from '../../../src/decoder';
import { rawTxs } from '../../../db/schema';
import { SUI_FIXTURES_DIR, loadSuiFixture } from '../../helpers/fixtures';

/**
 * Golden-fixture tests for the Sui protocol handlers ([1C.6]).
 *
 * Each fixture under tests/fixtures/sui/ is a REAL on-chain Sui tx (full
 * SuiTransactionBlockResponse as ingested by [1C.2]: showEvents +
 * showBalanceChanges + showEffects + showInput) with a hand-labeled
 * `expectedEvents: TaxEvent[]`. Committed BEFORE the handlers exist — these
 * tests are the failing artifact the turbos / navi / suilend handler issues
 * ([1C.3]–[1C.5]) implement against (mirror:
 * tests/chains/base/fixtures.test.ts, rotki test_aerodrome.py pattern).
 *
 * Fixture conventions (same as base):
 * - `foreign: true` marks txs from other users (case absent from own history).
 * - amounts are decimal strings (JSON has no bigint); revived via BigInt().
 * - `expectedEvents` omit `handlerVersion` (handlers version independently);
 *   every other TaxEvent field present in the fixture must match exactly.
 * - asset naming: token symbol (SUI, haSUI, USDC, ...) — matches the
 *   positions/eur-price test conventions.
 * - `scenario` tags the gnarly case from the [1C.6] spec the fixture covers.
 */


// [1C.6] asked for a haSUI loop "if present in history" — own history has none;
// the own-wallet Navi flash-loan leverage loop with Volo vSUI (identical event
// pattern, see navi-01 fixture notes) covers it as `lst_loop`.
const REQUIRED_SCENARIOS = [
  'lst_loop',
  'navi_liquidation',
  'turbos_rebalance',
  'suilend_supply_claim',
  'cross_protocol_ptb',
] as const;

const files = readdirSync(SUI_FIXTURES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

describe('sui golden fixtures (hand-labeled real txs — RED until 1C handlers land)', () => {
  test('covers all five [1C.6] scenarios', () => {
    const scenarios = new Set<string>();
    for (const file of files) {
      const fixture = loadSuiFixture(file);
      scenarios.add(fixture.scenario);
    }
    for (const required of REQUIRED_SCENARIOS) {
      expect(scenarios).toContain(required);
    }
  });

  for (const file of files) {
    const fixture = loadSuiFixture(file);

    test(`${file} (${fixture.protocol}/${fixture.scenario}${fixture.foreign ? ', foreign' : ''}): decodes to the hand-labeled TaxEvent[]`, () => {
      const { db } = createTestDb();
      db.insert(rawTxs)
        .values({
          chain: 'sui',
          txHash: fixture.txHash,
          blockNumber: fixture.blockNumber,
          blockTimestamp: Math.floor(Number(fixture.raw.timestampMs ?? 0) / 1000),
          rawJson: fixture.raw,
          fetchedAt: 0,
        })
        .run();

      const registry = createDefaultRegistry(db, { wallets: { sui: fixture.walletsContext } });
      const result = registry.decodeAndPersist('sui', fixture.txHash);

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
