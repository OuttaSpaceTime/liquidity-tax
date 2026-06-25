import { describe, it, expect } from 'bun:test';
import { createTestDb } from '../../helpers/db';
import {
  upsertEvents,
  recentActivity,
  getEventsByPosition,
  listTransactions,
  type EventInsert,
} from '../../../src/db/repos/events';

function row(overrides: Partial<EventInsert> = {}): EventInsert {
  return {
    chain: 'base',
    txHash: '0xtx',
    logIndex: 0,
    emissionSeq: 0,
    timestamp: 1_700_000_000,
    wallet: '0xwallet',
    type: 'swap',
    subtype: 'trade',
    handlerId: 'test_handler',
    handlerVersion: 1,
    ...overrides,
  };
}

describe('recentActivity', () => {
  it('returns events newest-first (timestamp DESC, id DESC)', () => {
    const { db } = createTestDb();
    upsertEvents(db, [
      row({ txHash: '0xa', timestamp: 100 }),
      row({ txHash: '0xb', timestamp: 300 }),
      row({ txHash: '0xc', timestamp: 200 }),
    ]);
    expect(recentActivity(db, { limit: 10 }).map((e) => e.txHash)).toEqual(['0xb', '0xc', '0xa']);
  });

  it('honours the limit', () => {
    const { db } = createTestDb();
    upsertEvents(db, [0, 1, 2, 3, 4].map((i) => row({ txHash: `0x${i}`, timestamp: 100 + i })));
    expect(recentActivity(db, { limit: 2 })).toHaveLength(2);
  });

  it('keyset-paginates on (timestamp, id) without dropping ties', () => {
    const { db } = createTestDb();
    // Three events share a timestamp; the surrogate id breaks the tie.
    upsertEvents(db, [
      row({ txHash: '0xa', logIndex: 0, timestamp: 500 }),
      row({ txHash: '0xa', logIndex: 1, timestamp: 500 }),
      row({ txHash: '0xa', logIndex: 2, timestamp: 500 }),
      row({ txHash: '0xold', timestamp: 100 }),
    ]);
    const firstPage = recentActivity(db, { limit: 2 });
    expect(firstPage).toHaveLength(2);
    const last = firstPage[firstPage.length - 1];
    const secondPage = recentActivity(db, {
      limit: 10,
      cursor: { timestamp: last.timestamp, id: last.id },
    });
    // No overlap, no gap: the two pages partition the four rows.
    const ids = [...firstPage, ...secondPage].map((e) => e.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('filters by wallet, chain, type and positionId', () => {
    const { db } = createTestDb();
    upsertEvents(db, [
      row({ txHash: '0xa', wallet: 'W1', chain: 'base', type: 'swap', subtype: 'trade' }),
      row({ txHash: '0xb', wallet: 'W2', chain: 'base', type: 'swap', subtype: 'trade' }),
      row({ txHash: '0xc', wallet: 'W1', chain: 'solana', type: 'swap', subtype: 'trade' }),
      row({
        txHash: '0xd',
        wallet: 'W1',
        chain: 'base',
        type: 'lp_fee',
        subtype: 'collect',
        positionId: 'base:uniswap_v3:1',
      }),
    ]);
    expect(recentActivity(db, { limit: 10, wallet: 'W1' }).map((e) => e.txHash).sort()).toEqual([
      '0xa',
      '0xc',
      '0xd',
    ]);
    expect(recentActivity(db, { limit: 10, chain: 'solana' }).map((e) => e.txHash)).toEqual(['0xc']);
    expect(recentActivity(db, { limit: 10, type: 'lp_fee' }).map((e) => e.txHash)).toEqual(['0xd']);
    expect(
      recentActivity(db, { limit: 10, positionId: 'base:uniswap_v3:1' }).map((e) => e.txHash),
    ).toEqual(['0xd']);
  });
});

describe('getEventsByPosition', () => {
  it('returns only that position, in canonical order', () => {
    const { db } = createTestDb();
    upsertEvents(db, [
      row({ txHash: '0xclose', logIndex: 50, timestamp: 5_000, positionId: 'base:uniswap_v3:1' }),
      row({ txHash: '0xopen', logIndex: 10, timestamp: 1_000, positionId: 'base:uniswap_v3:1' }),
      row({ txHash: '0xopen', logIndex: 10, emissionSeq: 1, timestamp: 1_000, positionId: 'base:uniswap_v3:1' }),
      row({ txHash: '0xother', positionId: 'base:uniswap_v3:2' }),
    ]);
    const got = getEventsByPosition(db, 'base:uniswap_v3:1');
    expect(got.map((e) => [e.timestamp, e.logIndex, e.emissionSeq])).toEqual([
      [1_000, 10, 0],
      [1_000, 10, 1],
      [5_000, 50, 0],
    ]);
  });
});

describe('listTransactions', () => {
  it('groups events into distinct txs, newest-first, with event counts', () => {
    const { db } = createTestDb();
    upsertEvents(db, [
      row({ txHash: '0xa', logIndex: 0, timestamp: 100 }),
      row({ txHash: '0xa', logIndex: 1, timestamp: 100 }),
      row({ txHash: '0xb', logIndex: 0, timestamp: 300 }),
      row({ txHash: '0xc', chain: 'solana', timestamp: 200 }),
    ]);
    const txs = listTransactions(db, { limit: 10 });
    expect(txs.map((t) => [t.txHash, t.eventCount])).toEqual([
      ['0xb', 1],
      ['0xc', 1],
      ['0xa', 2],
    ]);
    expect(listTransactions(db, { limit: 10, chain: 'solana' }).map((t) => t.txHash)).toEqual([
      '0xc',
    ]);
  });
});
