import { describe, it, expect } from 'bun:test';
import { createTestDb } from '../helpers/db';
import { DecoderRegistry, DuplicateEmissionError } from '../../src/decoder/registry';
import type { GenericRule, AggregationHook, RawTx } from '../../src/decoder/types';
import type { TaxEvent } from '../../src/types/event';
import { makeRawTx, makeEvent, makeHandler } from './helpers';

function newRegistry() {
  const { db } = createTestDb();
  return new DecoderRegistry(db);
}

describe('DecoderRegistry — phase 1 (handler dispatch)', () => {
  it('dispatches to a matching handler and returns its events', () => {
    const registry = newRegistry();
    const event = makeEvent({ handlerId: 'h1' });
    registry.registerHandler(makeHandler({ id: 'h1', result: { kind: 'ok', events: [event] } }));

    const result = registry.decode(makeRawTx());
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') throw new Error('unreachable');
    expect(result.events).toEqual([event]);
  });

  it('never calls decode on a handler whose matches() returns false', () => {
    const registry = newRegistry();
    let decodeCalled = false;
    registry.registerHandler(
      makeHandler({
        id: 'h1',
        matches: () => false,
        decode: () => {
          decodeCalled = true;
          return { kind: 'skip' };
        },
      }),
    );

    const result = registry.decode(makeRawTx());
    expect(decodeCalled).toBe(false);
    expect(result.status).toBe('unclassified');
  });

  it('never consults handlers registered for a different chain', () => {
    const registry = newRegistry();
    let matchesCalled = false;
    registry.registerHandler(
      makeHandler({
        id: 'sol-handler',
        chain: 'solana',
        matches: () => {
          matchesCalled = true;
          return true;
        },
      }),
    );

    registry.decode(makeRawTx({ chain: 'base' }));
    expect(matchesCalled).toBe(false);
  });

  it('runs handlers in registration order and exposes prior events via ctx.decodedEvents', () => {
    const registry = newRegistry();
    const first = makeEvent({ handlerId: 'first', logIndex: 0 });
    let seenByLater: readonly TaxEvent[] = [];
    registry.registerHandler(makeHandler({ id: 'first', result: { kind: 'ok', events: [first] } }));
    registry.registerHandler(
      makeHandler({
        id: 'second',
        decode: (_raw, ctx) => {
          seenByLater = [...ctx.decodedEvents];
          return { kind: 'ok', events: [makeEvent({ handlerId: 'second', logIndex: 1 })] };
        },
      }),
    );

    registry.decode(makeRawTx());
    expect(seenByLater).toEqual([first]);
  });

  it('rejects duplicate handler ids at registration time', () => {
    const registry = newRegistry();
    registry.registerHandler(makeHandler({ id: 'dup' }));
    expect(() => registry.registerHandler(makeHandler({ id: 'dup' }))).toThrow(/dup/);
  });

  it('returns skipped when a matching handler skips and nothing emits events', () => {
    const registry = newRegistry();
    registry.registerHandler(makeHandler({ id: 'spam-filter', result: { kind: 'skip' } }));

    const result = registry.decode(makeRawTx());
    expect(result.status).toBe('skipped');
  });
});

describe('DecoderRegistry — phase 2 (generic rules fallback)', () => {
  it('runs generic rules after handlers, exposing claimed log indexes', () => {
    const registry = newRegistry();
    registry.registerHandler(
      makeHandler({
        id: 'h1',
        result: { kind: 'ok', events: [makeEvent({ handlerId: 'h1', logIndex: 3 })] },
      }),
    );
    let observedClaimed: ReadonlySet<number> | undefined;
    const rule: GenericRule = {
      id: 'erc20-transfer',
      version: 1,
      apply: (_raw, ctx) => {
        observedClaimed = ctx.claimedLogIndexes;
        return [makeEvent({ handlerId: 'erc20-transfer', logIndex: 7 })];
      },
    };
    registry.registerGenericRule(rule);

    const result = registry.decode(makeRawTx());
    expect(observedClaimed).toEqual(new Set([3]));
    if (result.status !== 'decoded') throw new Error('expected decoded');
    expect(result.events.map((e) => e.handlerId).sort()).toEqual(['erc20-transfer', 'h1']);
  });

  it('classifies a tx no handler matched when a generic rule emits events', () => {
    const registry = newRegistry();
    const rule: GenericRule = {
      id: 'spl-transfer',
      version: 1,
      chain: 'solana',
      apply: () => [makeEvent({ handlerId: 'spl-transfer', chain: 'solana', txHash: 'soltx1' })],
    };
    registry.registerGenericRule(rule);

    const result = registry.decode(makeRawTx({ chain: 'solana', txHash: 'soltx1' }));
    expect(result.status).toBe('decoded');
  });

  it('skips generic rules registered for a different chain', () => {
    const registry = newRegistry();
    let called = false;
    const rule: GenericRule = {
      id: 'sui-coin-transfer',
      version: 1,
      chain: 'sui',
      apply: () => {
        called = true;
        return [];
      },
    };
    registry.registerGenericRule(rule);

    registry.decode(makeRawTx({ chain: 'base' }));
    expect(called).toBe(false);
  });
});

describe('DecoderRegistry — phase 3 (aggregation hooks)', () => {
  it('lets a hook collapse events (multi-hop swap shape) and runs hooks by priority', () => {
    const registry = newRegistry();
    registry.registerHandler(
      makeHandler({
        id: 'router',
        result: {
          kind: 'ok',
          events: [
            makeEvent({ handlerId: 'router', logIndex: 0, sentAsset: 'A', sentAmount: 10n }),
            makeEvent({ handlerId: 'router', logIndex: 1, receivedAsset: 'C', receivedAmount: 5n }),
          ],
        },
      }),
    );
    const order: string[] = [];
    const collapse: AggregationHook = {
      id: 'collapse-multihop',
      priority: 10,
      apply: (events) => {
        order.push('collapse');
        if (events.length !== 2) return events;
        return [
          makeEvent({
            handlerId: 'router',
            logIndex: 0,
            sentAsset: 'A',
            sentAmount: 10n,
            receivedAsset: 'C',
            receivedAmount: 5n,
          }),
        ];
      },
    };
    const audit: AggregationHook = {
      id: 'audit',
      priority: 20,
      apply: (events) => {
        order.push('audit');
        return events;
      },
    };
    // Register out of priority order on purpose.
    registry.registerAggregationHook(audit);
    registry.registerAggregationHook(collapse);

    const result = registry.decode(makeRawTx());
    expect(order).toEqual(['collapse', 'audit']);
    if (result.status !== 'decoded') throw new Error('expected decoded');
    expect(result.events).toHaveLength(1);
    expect(result.events[0].sentAsset).toBe('A');
    expect(result.events[0].receivedAsset).toBe('C');
  });
});

describe('DecoderRegistry — duplicate-emission guard', () => {
  it('throws DuplicateEmissionError naming both handlers on a (log_index, emission_seq) collision', () => {
    const registry = newRegistry();
    const collide = (handlerId: string) => makeEvent({ handlerId, logIndex: 2, emissionSeq: 0 });
    registry.registerHandler(
      makeHandler({ id: 'handler-a', result: { kind: 'ok', events: [collide('handler-a')] } }),
    );
    registry.registerHandler(
      makeHandler({ id: 'handler-b', result: { kind: 'ok', events: [collide('handler-b')] } }),
    );

    let caught: unknown;
    try {
      registry.decode(makeRawTx());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DuplicateEmissionError);
    const message = (caught as Error).message;
    expect(message).toContain('handler-a');
    expect(message).toContain('handler-b');
  });

  it('throws even when type/subtype differ on the same (log_index, emission_seq)', () => {
    // The guard key matches the DB unique constraint events_uq (4-tuple): two
    // events differing only in classification would still collide at insert,
    // so they must fail here with the descriptive error.
    const registry = newRegistry();
    registry.registerHandler(
      makeHandler({
        id: 'handler-a',
        result: {
          kind: 'ok',
          events: [
            makeEvent({ handlerId: 'handler-a', logIndex: 2, type: 'swap', subtype: 'trade' }),
          ],
        },
      }),
    );
    registry.registerHandler(
      makeHandler({
        id: 'handler-b',
        result: {
          kind: 'ok',
          events: [makeEvent({ handlerId: 'handler-b', logIndex: 2, type: 'gas', subtype: 'fee' })],
        },
      }),
    );

    expect(() => registry.decode(makeRawTx())).toThrow(DuplicateEmissionError);
  });
});

describe('DecoderRegistry — deterministic ordering', () => {
  it('returns events sorted by (tx_hash, log_index, emission_seq, handler_id)', () => {
    const registry = newRegistry();
    registry.registerHandler(
      makeHandler({
        id: 'zz-late',
        result: {
          kind: 'ok',
          events: [
            makeEvent({ handlerId: 'zz-late', logIndex: 1, emissionSeq: 1 }),
            makeEvent({
              handlerId: 'zz-late',
              logIndex: 0,
              emissionSeq: 0,
              type: 'gas',
              subtype: 'fee',
            }),
          ],
        },
      }),
    );
    registry.registerHandler(
      makeHandler({
        id: 'aa-early',
        result: {
          kind: 'ok',
          events: [makeEvent({ handlerId: 'aa-early', logIndex: 1, emissionSeq: 0 })],
        },
      }),
    );

    const result = registry.decode(makeRawTx());
    if (result.status !== 'decoded') throw new Error('expected decoded');
    expect(result.events.map((e) => [e.logIndex, e.emissionSeq, e.handlerId])).toEqual([
      [0, 0, 'zz-late'],
      [1, 0, 'aa-early'],
      [1, 1, 'zz-late'],
    ]);
  });

  it('produces identical event order regardless of handler registration order', () => {
    const handlers = [
      makeHandler({
        id: 'alpha',
        result: { kind: 'ok', events: [makeEvent({ handlerId: 'alpha', logIndex: 5 })] },
      }),
      makeHandler({
        id: 'beta',
        result: {
          kind: 'ok',
          events: [makeEvent({ handlerId: 'beta', logIndex: 1, type: 'gas', subtype: 'fee' })],
        },
      }),
      makeHandler({
        id: 'gamma',
        result: {
          kind: 'ok',
          events: [
            makeEvent({
              handlerId: 'gamma',
              logIndex: 1,
              emissionSeq: 1,
              type: 'transfer',
              subtype: 'receive',
            }),
          ],
        },
      }),
    ];

    const decodeWith = (ordered: typeof handlers) => {
      const registry = newRegistry();
      for (const h of ordered) registry.registerHandler(h);
      const result = registry.decode(makeRawTx());
      if (result.status !== 'decoded') throw new Error('expected decoded');
      return result.events;
    };

    const a = decodeWith([handlers[0], handlers[1], handlers[2]]);
    const b = decodeWith([handlers[2], handlers[0], handlers[1]]);
    const c = decodeWith([handlers[1], handlers[2], handlers[0]]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});

describe('DecoderRegistry — unclassified fallback', () => {
  it('returns unclassified with a non-empty reason when no handler matches', () => {
    const registry = newRegistry();
    const result = registry.decode(makeRawTx());
    expect(result.status).toBe('unclassified');
    if (result.status !== 'unclassified') throw new Error('unreachable');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('propagates handler-provided unclassified reasons', () => {
    const registry = newRegistry();
    registry.registerHandler(
      makeHandler({
        id: 'navi',
        result: { kind: 'unclassified', reason: 'unknown navi event type FlashLoanX' },
      }),
    );

    const result = registry.decode(makeRawTx());
    if (result.status !== 'unclassified') throw new Error('expected unclassified');
    expect(result.reason).toContain('navi');
    expect(result.reason).toContain('unknown navi event type FlashLoanX');
  });

  it('routes the whole tx to the manual queue when any handler reports a problem, even if another decoded events', () => {
    // Review finding: the Sui handlers (navi/suilend/turbos) implement an
    // all-or-nothing contract — a single problem discards that handler's own
    // events. If the registry then marked the tx 'decoded' because ANOTHER
    // handler emitted events (e.g. turbos decoding the swap of a PTB whose
    // Navi legs tripped a guard), the dropped legs would silently understate
    // taxable activity with no trace. Conservative rule: any unclassified
    // reason sends the WHOLE tx to the manual queue.
    const registry = newRegistry();
    registry.registerHandler(
      makeHandler({ id: 'confused', result: { kind: 'unclassified', reason: 'no idea' } }),
    );
    registry.registerHandler(
      makeHandler({
        id: 'confident',
        result: { kind: 'ok', events: [makeEvent({ handlerId: 'confident' })] },
      }),
    );

    const result = registry.decode(makeRawTx());
    expect(result.status).toBe('unclassified');
    if (result.status !== 'unclassified') throw new Error('unreachable');
    expect(result.reason).toContain('confused');
    expect(result.reason).toContain('no idea');
  });
});

describe('DecoderRegistry — wallets in DecodeContext', () => {
  it('exposes configured owner wallets for the raw tx chain', () => {
    const { db } = createTestDb();
    const registry = new DecoderRegistry(db, {
      wallets: { base: ['0xowner1', '0xowner2'], solana: ['solOwner'] },
    });
    let seen: ReadonlySet<string> | undefined;
    registry.registerHandler(
      makeHandler({
        id: 'h1',
        decode: (_raw: RawTx, ctx) => {
          seen = ctx.wallets;
          return { kind: 'skip' };
        },
      }),
    );

    registry.decode(makeRawTx({ chain: 'base' }));
    expect(seen).toEqual(new Set(['0xowner1', '0xowner2']));
  });
});
