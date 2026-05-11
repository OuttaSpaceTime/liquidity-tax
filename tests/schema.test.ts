import { describe, it, expect } from 'bun:test';
import { createTestDb } from './helpers/db';
import { events } from '../db/schema';

describe('schema smoke', () => {
  it('all 7 tables exist after migration', () => {
    const { sqlite } = createTestDb();
    const rows = sqlite
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '__drizzle%' AND name != 'sqlite_sequence' ORDER BY name",
      )
      .all();
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual([
      'events',
      'positions',
      'prices',
      'raw_txs',
      'rules',
      'transfer_links',
      'unclassified',
    ]);
  });

  it('bigint round-trip on events.sent_amount preserves precision past 2^53', () => {
    const { db } = createTestDb();
    const amount = 2n ** 65n;
    db.insert(events)
      .values({
        chain: 'base',
        txHash: '0xabc',
        logIndex: 0,
        emissionSeq: 0,
        timestamp: 1700000000,
        wallet: '0x1',
        type: 'trade',
        subtype: 'swap',
        sentAmount: amount,
        handlerId: 'test',
        handlerVersion: 1,
      })
      .run();
    const rows = db.select().from(events).all();
    expect(rows[0].sentAmount).toBe(amount);
  });
});
