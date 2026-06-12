import { describe, expect, it } from 'bun:test';
import { DecoderRegistry } from '../../src/decoder';
import type { RawTx } from '../../src/decoder/types';
import { suilendHandler } from '../../src/handlers/suilend';
import type { TaxEvent } from '../../src/types/event';
import { createTestDb } from '../helpers/db';
import {
  SUI_FIXTURES_DIR,
  listFixtureFiles,
  loadSuiFixture,
  suiFixtureToRawTx,
  type FixtureEvent,
} from '../helpers/fixtures';

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


/** Every fixture whose hand-labeled events belong to the suilend handler. */
const files = listFixtureFiles(SUI_FIXTURES_DIR).filter(
  (f) => f.startsWith('suilend-') || f.startsWith('cross-01'),
);

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
      expect(suilendHandler.matches(suiFixtureToRawTx(loadSuiFixture(file)))).toBe(true);
    }
  });

  for (const file of files) {
    const fixture = loadSuiFixture(file);
    it(`${file} (${fixture.scenario}${fixture.foreign ? ', foreign' : ''}): decodes to the hand-labeled TaxEvent[]`, () => {
      const result = makeRegistry(fixture.walletsContext).decode(suiFixtureToRawTx(fixture));
      expect(result.status).toBe(fixture.expectedStatus ?? 'decoded');
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
    const fixture = loadSuiFixture(files[0]!);
    const raw = suiFixtureToRawTx(fixture);
    expect(suilendHandler.matches(raw)).toBe(true);
    const result = makeRegistry([
      '0x000000000000000000000000000000000000000000000000000000000000dead',
    ]).decode(raw);
    expect(result.status).toBe('skipped');
  });

  it('does not match a non-Suilend sui tx', () => {
    const turbos = listFixtureFiles(SUI_FIXTURES_DIR, 'turbos-01')[0];
    expect(turbos).toBeDefined();
    expect(suilendHandler.matches(suiFixtureToRawTx(loadSuiFixture(turbos!)))).toBe(false);
  });
});

describe('suilend — aggregator mirror dedup (review regression)', () => {
  it('emits ONE swap:trade when a 7K route carries both router::SwapEvent and the settle::Swap mirror', () => {
    // One zap route can emit BOTH summaries; emitting both would double-count
    // the trade. Synthetic raw (shape-only; payloads mirror cross-01/suilend-03).
    const sender = `0x${'a'.repeat(64)}`;
    const sui = { name: '0000000000000000000000000000000000000000000000000000000000000002::sui::SUI' };
    const usdc = { name: 'dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC' };
    const raw: RawTx = {
      chain: 'sui',
      txHash: 'SyntheticMirrorDigest',
      blockNumber: 1,
      blockTimestamp: 1_700_000_000,
      fetchedAt: 0,
      rawJson: {
        transaction: { data: { sender } },
        events: [
          {
            type: '0x33ec64e9bb369bf045ddc198c81adbf2acab424da37465d95296ee02045d2b17::router::SwapEvent',
            parsedJson: { amount_in: '1000000', amount_out: '2000000', from: sui, target: usdc },
          },
          {
            type: '0xe8f996ea6ff38c557c253d3b93cfe2ebf393816487266786371aa4532a9229f2::settle::Swap',
            parsedJson: { amount_in: '1000000', amount_out: '2000000', coin_in: sui, coin_out: usdc },
          },
        ],
      },
    } as RawTx;

    const result = suilendHandler.decode(raw, {
      wallets: new Set([sender]),
      decodedEvents: [],
      claimedLogIndexes: new Set<number>(),
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.events.filter((e) => e.type === 'swap')).toHaveLength(1);
  });
});

describe('suilend — ctoken conversion without a rate snapshot (review regression)', () => {
  it('routes a standalone ctoken Withdraw with no same-tx ReserveAssetDataEvent to the manual queue', () => {
    // toUnderlying would otherwise silently assume 1:1 — the exchange rate
    // only grows over time, so the underlying would be understated with no
    // problem raised. Synthetic shape-only raw (payload mirrors suilend-02).
    const sender = `0x${'c'.repeat(64)}`;
    const raw: RawTx = {
      chain: 'sui',
      txHash: 'SyntheticNoRateDigest',
      blockNumber: 1,
      blockTimestamp: 1_700_000_000,
      fetchedAt: 0,
      rawJson: {
        transaction: { data: { sender } },
        events: [
          {
            type: '0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf::lending_market::WithdrawEvent',
            parsedJson: {
              lending_market_id: '0x1',
              coin_type: {
                name: '0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
              },
              reserve_id: '0x2',
              obligation_id: '0x3',
              ctoken_amount: '969991680',
            },
          },
        ],
      },
    } as RawTx;

    const result = suilendHandler.decode(raw, {
      wallets: new Set([sender]),
      decodedEvents: [],
      claimedLogIndexes: new Set<number>(),
    });

    expect(result.kind).toBe('unclassified');
    if (result.kind === 'unclassified') {
      expect(result.reason).toContain('exchange rate');
    }
  });
});

describe('suilend — unrecognized swap legs in an owned PTB (review regression)', () => {
  it('routes an owned PTB with a swap event from an unrecognized venue to the manual queue', () => {
    // Review finding: unlike navi, suilend silently ignored foreign swap
    // events — an owned Suilend PTB disposing coins through a venue with a
    // different summary event (direct Cetus swap, unknown aggregator) decoded
    // kind:'ok' with only the lend legs, dropping the §23-relevant disposal.
    // Variant of REAL fixture suilend-01 with a Cetus pool::SwapEvent (real
    // type string from suilend-04) appended; no recognized route summary is
    // present, so the disposal cannot be attributed to any decoded trade.
    const fixture = loadSuiFixture('suilend-01-borrow-claim-redeposit.json');
    (fixture.raw.events as unknown[]).push({
      type: '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::SwapEvent',
      parsedJson: { pool: '0x1', amount_in: '1000000', amount_out: '900000', atob: true },
    });

    const result = makeRegistry(fixture.walletsContext).decode(suiFixtureToRawTx(fixture));
    expect(result.status).toBe('unclassified');
    if (result.status === 'unclassified') {
      expect(result.reason).toContain('pool::SwapEvent');
    }
  });

  it('still decodes owned PTBs whose per-pool swap legs belong to a RECOGNIZED route summary (suilend-03)', () => {
    // suilend-03 carries Cetus/Bluefin per-hop legs under a settle::Swap
    // total — those are the route's internals, not unrecognized disposals.
    const fixture = loadSuiFixture('suilend-03-flash-repay-redeposit.json');
    const result = makeRegistry(fixture.walletsContext).decode(suiFixtureToRawTx(fixture));
    expect(result.status).toBe('decoded');
  });
});
