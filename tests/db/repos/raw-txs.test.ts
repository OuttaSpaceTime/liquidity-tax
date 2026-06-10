import { describe, it, expect } from 'bun:test';
import { createTestDb } from '../../helpers/db';
import {
  upsertRawTxs,
  getRawTx,
  listRawTxKeys,
  countRawTxsByChain,
} from '../../../src/db/repos/raw-txs';

function row(overrides: Partial<Parameters<typeof upsertRawTxs>[1][number]> = {}) {
  return {
    chain: 'base',
    txHash: '0xaaa',
    blockNumber: 100,
    blockTimestamp: 1_700_000_000,
    rawJson: { logs: [] },
    fetchedAt: 1_700_000_100,
    ...overrides,
  };
}

describe('raw-txs repo', () => {
  it('inserts and reads back a raw tx', () => {
    const { db } = createTestDb();
    upsertRawTxs(db, [row()]);
    const got = getRawTx(db, 'base', '0xaaa');
    expect(got).toBeDefined();
    expect(got!.blockNumber).toBe(100);
    expect(got!.rawJson).toEqual({ logs: [] });
  });

  it('upsert is idempotent on (chain, tx_hash) — re-run updates payload, no duplicate', () => {
    const { db } = createTestDb();
    upsertRawTxs(db, [row()]);
    upsertRawTxs(db, [row({ rawJson: { logs: [1] }, fetchedAt: 1_700_000_200 })]);
    const all = listRawTxKeys(db);
    expect(all).toHaveLength(1);
    const got = getRawTx(db, 'base', '0xaaa');
    expect(got!.rawJson).toEqual({ logs: [1] });
    expect(got!.fetchedAt).toBe(1_700_000_200);
  });

  it('same tx_hash on different chains are distinct rows', () => {
    const { db } = createTestDb();
    upsertRawTxs(db, [row(), row({ chain: 'solana' })]);
    expect(listRawTxKeys(db)).toHaveLength(2);
    expect(listRawTxKeys(db, 'solana')).toHaveLength(1);
  });

  it('batches large upserts in one call', () => {
    const { db } = createTestDb();
    const rows = Array.from({ length: 450 }, (_, i) => row({ txHash: `0x${i}` }));
    upsertRawTxs(db, rows);
    expect(listRawTxKeys(db)).toHaveLength(450);
  });

  it('counts per chain', () => {
    const { db } = createTestDb();
    upsertRawTxs(db, [row(), row({ txHash: '0xbbb' }), row({ chain: 'sui', txHash: 'sui1' })]);
    const counts = countRawTxsByChain(db);
    expect(counts).toEqual(
      expect.arrayContaining([
        { chain: 'base', count: 2 },
        { chain: 'sui', count: 1 },
      ]),
    );
  });
});
