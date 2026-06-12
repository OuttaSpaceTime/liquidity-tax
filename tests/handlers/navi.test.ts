import { describe, expect, it } from 'bun:test';
import { DecoderRegistry } from '../../src/decoder';
import type { RawTx } from '../../src/decoder/types';
import { naviHandler } from '../../src/handlers/navi';
import type { TaxEvent } from '../../src/types/event';
import { createTestDb } from '../helpers/db';
import { loadSuiFixture, suiFixtureToRawTx, type FixtureEvent } from '../helpers/fixtures';

/**
 * [1C.4] Navi handler tests, driven by the [1C.6] hand-labeled Sui golden
 * fixtures (tests/fixtures/sui/navi-*.json — real on-chain txs committed
 * before this handler existed). Like tests/handlers/orca-whirlpool.test.ts,
 * this suite registers the real handler directly into a fresh registry so it
 * runs red-first regardless of the `createDefaultRegistry` stub wiring (the
 * stub swap happens in the Integrate phase).
 */


const NAVI_FIXTURES = [
  'navi-01-lst-flash-leverage-loop.json',
  'navi-02-liquidation.json',
  'navi-03-reward-claim-compound.json',
  // Foreign tx covering the Haedal staking::UserStaked (haSUI) decode path +
  // lending::WithdrawEvent pool-leg pairing — absent from own history (the
  // own-wallet loop uses Volo vSUI, navi-01). No looping_pattern: collateral
  // migration has no SUI borrow leg.
  'navi-04-hasui-collateral-migration.json',
];

/** Sui fixtures owned by other handlers — the Navi handler must not claim them. */
const OTHER_SUI_FIXTURES = [
  'turbos-01-rebalance-close-collect.json',
  'turbos-02-open-zap-aggregator-swap.json',
  'suilend-01-borrow-claim-redeposit.json',
  'cross-01-suilend-claim-lst-redeem-swap.json',
];

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
      expect(naviHandler.matches(suiFixtureToRawTx(loadSuiFixture(file)))).toBe(true);
    }
  });

  it('does not match the turbos/suilend/cross sui fixtures', () => {
    for (const file of OTHER_SUI_FIXTURES) {
      expect(naviHandler.matches(suiFixtureToRawTx(loadSuiFixture(file)))).toBe(false);
    }
  });

  for (const file of NAVI_FIXTURES) {
    const fixture = loadSuiFixture(file);
    it(`${file} (${fixture.scenario}${fixture.foreign ? ', foreign' : ''}): decodes to the hand-labeled outcome`, () => {
      const result = makeRegistry(fixture.walletsContext).decode(suiFixtureToRawTx(fixture));
      expect(result.status).toBe(fixture.expectedStatus ?? 'decoded');
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
    const fixture = loadSuiFixture('navi-02-liquidation.json');
    const raw = suiFixtureToRawTx(fixture);
    expect(naviHandler.matches(raw)).toBe(true);
    const result = makeRegistry(['0x' + 'ab'.repeat(32)]).decode(raw);
    expect(result.status).toBe('skipped');
  });

  it('routes an owned liquidator side to the manual queue (unclassified, not silent)', () => {
    // Same real liquidation tx, but configured as if the BOT were our wallet:
    // liquidator-perspective decoding is out of scope, must not decode silently.
    const fixture = loadSuiFixture('navi-02-liquidation.json');
    const raw = suiFixtureToRawTx(fixture);
    const liquidationEvent = (
      fixture.raw as { events: { type: string; parsedJson: { sender: string } }[] }
    ).events.find((e) => e.type.endsWith('::lending::LiquidationEvent'));
    expect(liquidationEvent).toBeDefined();
    const result = makeRegistry([liquidationEvent!.parsedJson.sender]).decode(raw);
    expect(result.status).toBe('unclassified');
  });
});

describe('navi — owned PTB guards (review regressions)', () => {
  it('routes an owned PTB with an unrecognized foreign-protocol swap leg to the manual queue', () => {
    // navi-04 contains a Cetus pool::SwapEvent (idx 15) disposing the
    // withdrawn vSUI — no handler decodes it, so a kind:'ok' here would
    // silently understate taxable activity (§7: standalone LST swaps ARE
    // disposals). Pinned via the fixture's expectedStatus too; this test
    // documents the reason text.
    const fixture = loadSuiFixture('navi-04-hasui-collateral-migration.json');
    const result = makeRegistry(fixture.walletsContext).decode(suiFixtureToRawTx(fixture));
    expect(result.status).toBe('unclassified');
    if (result.status === 'unclassified') {
      expect(result.reason).toContain('swap');
    }
  });

  it('rejects pool-leg pairing whose coin type contradicts the reserve registry (same-amount collision)', () => {
    // Two same-raw-amount pool legs of DIFFERENT coins: nearest-preceding
    // pairing would hand the USDT leg to the USDC (reserve 10) deposit. The
    // registry knows reserve 10 = USDC, so the contradiction must surface as
    // unclassified instead of a silent asset mislabel. Synthetic shape-only
    // raw (payload shapes mirror navi-04's real PoolDeposit/DepositEvent).
    const sender = `0x${'b'.repeat(64)}`;
    const lending = '0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca';
    const raw: RawTx = {
      chain: 'sui',
      txHash: 'SyntheticPairingDigest',
      blockNumber: 1,
      blockTimestamp: 1_700_000_000,
      fetchedAt: 0,
      rawJson: {
        transaction: { data: { sender } },
        events: [
          {
            type: `${lending}::pool::PoolDeposit`,
            parsedJson: {
              sender,
              amount: '1000000',
              pool: 'dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
            },
          },
          {
            type: `${lending}::pool::PoolDeposit`,
            parsedJson: {
              sender,
              amount: '1000000',
              pool: 'c060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN',
            },
          },
          {
            // reserve 10 = USDC, but the NEAREST preceding same-amount leg is
            // the USDT (wormhole ::coin::COIN) one at index 1.
            type: `${lending}::lending::DepositEvent`,
            parsedJson: { reserve: 10, sender, amount: '1000000' },
          },
        ],
      },
    } as RawTx;

    const result = makeRegistry([sender]).decode(raw);
    expect(result.status).toBe('unclassified');
    if (result.status === 'unclassified') {
      expect(result.reason).toContain('reserve');
    }
  });
});
