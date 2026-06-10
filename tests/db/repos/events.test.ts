import { describe, it, expect } from 'bun:test';
import { createTestDb } from '../../helpers/db';
import {
  upsertEvents,
  getEventsByTx,
  deleteEventsByTx,
  countEventsByChain,
  type EventInsert,
} from '../../../src/db/repos/events';

function row(overrides: Partial<EventInsert> = {}): EventInsert {
  return {
    chain: 'base',
    txHash: '0xaaa',
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

describe('events repo', () => {
  it('round-trips bigint amounts past 2^53 through the blob columns', () => {
    const { db } = createTestDb();
    const sent = 2n ** 70n + 3n;
    const received = 123_456_789_012_345_678_901n;
    upsertEvents(db, [row({ sentAmount: sent, receivedAmount: received })]);
    const [got] = getEventsByTx(db, 'base', '0xaaa');
    expect(got.sentAmount).toBe(sent);
    expect(got.receivedAmount).toBe(received);
  });

  it('upsert is idempotent on (chain, tx_hash, log_index, emission_seq)', () => {
    const { db } = createTestDb();
    upsertEvents(db, [row()]);
    upsertEvents(db, [row({ type: 'transfer', subtype: 'send', handlerVersion: 2 })]);
    const got = getEventsByTx(db, 'base', '0xaaa');
    expect(got).toHaveLength(1);
    expect(got[0].type).toBe('transfer');
    expect(got[0].handlerVersion).toBe(2);
  });

  it('distinct emission_seq on the same log index are separate rows', () => {
    const { db } = createTestDb();
    upsertEvents(db, [row(), row({ emissionSeq: 1 })]);
    expect(getEventsByTx(db, 'base', '0xaaa')).toHaveLength(2);
  });

  it('getEventsByTx returns rows ordered by (log_index, emission_seq)', () => {
    const { db } = createTestDb();
    upsertEvents(db, [row({ logIndex: 5 }), row({ logIndex: 1, emissionSeq: 1 }), row({ logIndex: 1 })]);
    const got = getEventsByTx(db, 'base', '0xaaa');
    expect(got.map((e) => [e.logIndex, e.emissionSeq])).toEqual([
      [1, 0],
      [1, 1],
      [5, 0],
    ]);
  });

  it('deleteEventsByTx removes only the targeted tx', () => {
    const { db } = createTestDb();
    upsertEvents(db, [row(), row({ txHash: '0xbbb' })]);
    deleteEventsByTx(db, 'base', '0xaaa');
    expect(getEventsByTx(db, 'base', '0xaaa')).toHaveLength(0);
    expect(getEventsByTx(db, 'base', '0xbbb')).toHaveLength(1);
  });

  it('counts per chain', () => {
    const { db } = createTestDb();
    upsertEvents(db, [row(), row({ logIndex: 1 }), row({ chain: 'solana', txHash: 'sig1' })]);
    expect(countEventsByChain(db)).toEqual(
      expect.arrayContaining([
        { chain: 'base', count: 2 },
        { chain: 'solana', count: 1 },
      ]),
    );
  });
});
