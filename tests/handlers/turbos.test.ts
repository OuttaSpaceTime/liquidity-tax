import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DecoderRegistry } from '../../src/decoder';
import type { RawTx } from '../../src/decoder/types';
import { turbosHandler } from '../../src/handlers/turbos';
import { groupEventsByPosition, reducePositionEvents } from '../../src/positions';
import type { TaxEvent } from '../../src/types/event';
import { createTestDb } from '../helpers/db';

/**
 * [1C.3] Turbos CLMM handler tests, driven by the hand-labeled golden
 * fixtures under tests/fixtures/sui/turbos-*.json ([1C.6] committed
 * turbos-01/-02; turbos-03/-04 added with this issue from own ingested
 * history). Like tests/handlers/orca-whirlpool.test.ts, this suite registers
 * the real handler directly so it runs red-first regardless of foundation
 * wiring (the registry-level suite tests/chains/sui/fixtures.test.ts stays
 * red until the Integrate phase swaps `turbosStub` in createDefaultRegistry).
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

const fixtures = readdirSync(FIXTURES_DIR)
  .filter((f) => f.startsWith('turbos-') && f.endsWith('.json'))
  .sort()
  .map((file) => ({
    file,
    fixture: JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')) as SuiFixture,
  }));

function toRawTx(fixture: SuiFixture): RawTx {
  return {
    chain: 'sui',
    txHash: fixture.txHash,
    blockNumber: fixture.blockNumber,
    blockTimestamp: Math.floor(Number(fixture.raw.timestampMs ?? 0) / 1000),
    rawJson: fixture.raw,
    fetchedAt: 0,
  } as RawTx;
}

function makeRegistry(wallets: readonly string[]): DecoderRegistry {
  const { db } = createTestDb();
  const registry = new DecoderRegistry(db, { wallets: { sui: [...wallets] } });
  registry.registerHandler(turbosHandler);
  return registry;
}

function decodeFixture(fixture: SuiFixture): TaxEvent[] {
  const result = makeRegistry(fixture.walletsContext).decode(toRawTx(fixture));
  expect(result.status).toBe('decoded');
  return result.status === 'decoded' ? result.events : [];
}

describe('turbos handler [1C.3]', () => {
  it('covers at least 3 hand-labeled real txs', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
  });

  it('is a real handler (version > 0, sui, id turbos)', () => {
    expect(turbosHandler.id).toBe('turbos');
    expect(turbosHandler.chain).toBe('sui');
    expect(turbosHandler.version).toBeGreaterThan(0);
  });

  it('matches every turbos fixture tx', () => {
    for (const { fixture } of fixtures) {
      expect(turbosHandler.matches(toRawTx(fixture))).toBe(true);
    }
  });

  for (const { file, fixture } of fixtures) {
    it(`${file} (${fixture.scenario}${fixture.foreign ? ', foreign' : ''}): decodes to the hand-labeled TaxEvent[]`, () => {
      const events = decodeFixture(fixture);
      expect(events).toHaveLength(fixture.expectedEvents.length);
      for (const [i, expected] of fixture.expectedEvents.entries()) {
        const actual = events[i]!;
        const { sentAmount, receivedAmount, ...fields } = expected;
        expect(actual).toMatchObject(fields as Record<string, unknown>);
        // Strict flags: hand-labels omitting `flags` mean NO flags — spurious
        // handler flags directly drive tax treatment and must fail here.
        expect(actual.flags ?? []).toEqual(fields.flags ?? []);
        expect(actual.sentAmount).toBe(
          sentAmount === undefined ? undefined : BigInt(sentAmount),
        );
        expect(actual.receivedAmount).toBe(
          receivedAmount === undefined ? undefined : BigInt(receivedAmount),
        );
        expect(actual.handlerId).toBe('turbos');
        expect(actual.chain).toBe('sui');
        expect(actual.txHash).toBe(fixture.txHash);
      }
    });
  }

  it('skips a Turbos tx where no configured wallet is involved', () => {
    const { fixture } = fixtures[0]!;
    const raw = toRawTx(fixture);
    expect(turbosHandler.matches(raw)).toBe(true);
    const result = makeRegistry(['0x' + 'f'.repeat(64)]).decode(raw);
    expect(result.status).toBe('skipped');
  });
});

describe('turbos — aggregator-summary dedup across handlers (review regression)', () => {
  it('defers when an earlier handler already claimed the SAME trade at a DIFFERENT mirror index', () => {
    // turbos-02 carries two mirroring route summaries (universal_router::Swap
    // @23 and settle::Swap @24). If an earlier handler (navi/suilend) claimed
    // the settle mirror, turbos preferring the universal_router index must NOT
    // emit the same trade again — one route, one swap:trade.
    const { fixture } = fixtures.find((f) => f.file.startsWith('turbos-02'))!;
    const raw = toRawTx(fixture);
    const sender = fixture.walletsContext[0]!;
    const claimedBySuilend: TaxEvent = {
      type: 'swap',
      subtype: 'trade',
      chain: 'sui',
      txHash: fixture.txHash,
      logIndex: 24, // the settle::Swap mirror — different index than turbos' pick (23)
      emissionSeq: 0,
      timestamp: raw.blockTimestamp,
      wallet: sender,
      sentAsset: 'SUI',
      sentAmount: 3306294403861n,
      receivedAsset: 'USDC',
      receivedAmount: 4787913671n,
      handlerId: 'suilend',
      handlerVersion: 1,
    };

    const result = turbosHandler.decode(raw, {
      wallets: new Set([sender]),
      decodedEvents: [claimedBySuilend],
      claimedLogIndexes: new Set<number>(),
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.events.filter((e) => e.type === 'swap')).toHaveLength(0);
    // the open_position legs still decode
    expect(result.events.filter((e) => e.type === 'lp_deposit')).toHaveLength(2);
  });
});

describe('turbos position tracker integration', () => {
  it('reduces turbos-01 (rebalance close leg) to a closed snapshot with fees and rewards', () => {
    const closeFixture = fixtures.find((f) => f.fixture.scenario === 'turbos_rebalance')!.fixture;
    const events = decodeFixture(closeFixture);
    const positionId =
      'sui:turbos:0x942ff2f06024309391de1b38d777d8f10d1f92265bb63fbd66cb5306aca2d964';
    const groups = groupEventsByPosition(events);
    const snapshot = reducePositionEvents(positionId, groups.get(positionId) ?? []);

    expect(snapshot).toBeDefined();
    if (snapshot === undefined) return;
    expect(snapshot.chain).toBe('sui');
    expect(snapshot.protocol).toBe('turbos');
    expect(snapshot.state.status).toBe('closed');
    // Open tx predates the close-leg fixture — the reducer infers the open.
    expect(snapshot.state.inferredOpen).toBe(true);
    expect(snapshot.state.withdrawn).toEqual({ SUI: '64188923624', USDC: '1094501918' });
    expect(snapshot.state.feesCollected).toEqual({ SUI: '100758185', USDC: '140491' });
    expect(snapshot.state.rewardsCollected).toEqual({ SUI: '70557839' });
  });

  it('reduces turbos-02 (zap re-open leg) to an open snapshot with both deposit legs', () => {
    const openFixture = fixtures.find((f) => f.fixture.scenario === 'turbos_open_zap')!.fixture;
    const events = decodeFixture(openFixture);
    const positionId =
      'sui:turbos:0xc7202c7bc74d997c6173dc1e884e04d02393076224cbceb75008a6e9a1fcfb12';
    const snapshot = reducePositionEvents(
      positionId,
      groupEventsByPosition(events).get(positionId) ?? [],
    );

    expect(snapshot).toBeDefined();
    if (snapshot === undefined) return;
    expect(snapshot.state.status).toBe('open');
    expect(snapshot.state.inferredOpen).toBe(false);
    expect(snapshot.state.deposited).toEqual({ SUI: '3193705596139', USDC: '4670695317' });
  });

  it('every position-scoped event reduces without unexpected-type warnings (all fixtures)', () => {
    const events = fixtures.flatMap(({ fixture }) => decodeFixture(fixture));
    for (const [positionId, group] of groupEventsByPosition(events)) {
      const snapshot = reducePositionEvents(positionId, group);
      expect(snapshot).toBeDefined();
      const warnings = snapshot?.state.warnings ?? [];
      expect(warnings.filter((w) => w.startsWith('unexpected_event_type'))).toEqual([]);
    }
  });
});
