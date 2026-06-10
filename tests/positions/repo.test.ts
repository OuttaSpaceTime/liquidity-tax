import { describe, it, expect } from 'bun:test';
import { createTestDb } from '../helpers/db';
import { positions } from '../../db/schema';
import { upsertEvents, deleteEventsByTx } from '../../src/db/repos/events';
import {
  getPosition,
  listPositions,
  positionState,
  rebuildAllPositions,
  rebuildPositions,
  syncPositionsForEvents,
} from '../../src/positions/repo';
import { lpEvent, uniLifecycle, TURBOS_POS, UNI_POS, UNI_POS_2 } from './helpers';

function turbosOpen() {
  return lpEvent({
    positionId: TURBOS_POS,
    chain: 'sui',
    wallet: 'wallet-phantom-sui',
    type: 'lp_deposit',
    subtype: 'open_position',
    txHash: 'digest-open',
    timestamp: 7_000,
    sentAsset: '0x2::sui::SUI',
    sentAmount: 42n,
  });
}

describe('positions repo', () => {
  it('rebuilds a position row from persisted events', () => {
    const { db } = createTestDb();
    upsertEvents(db, uniLifecycle().slice(0, 4)); // open (2 legs) + increase (2 legs)

    const result = rebuildPositions(db, [UNI_POS]);
    expect(result).toEqual({ upserted: 1, deleted: 0 });

    const row = getPosition(db, UNI_POS)!;
    expect(row.chain).toBe('base');
    expect(row.protocol).toBe('uniswap_v3');
    expect(row.wallet).toBe('wallet-rabby');
    expect(row.openedAt).toBe(1_000);
    expect(row.closedAt).toBeNull();

    const state = positionState(row);
    expect(state.status).toBe('open');
    expect(state.deposited).toEqual({ USDC: '3750000000', WETH: '1500000000000000000' });
  });

  it('persists closedAt once the closing events land', () => {
    const { db } = createTestDb();
    upsertEvents(db, uniLifecycle());
    rebuildPositions(db, [UNI_POS]);

    const row = getPosition(db, UNI_POS)!;
    expect(row.closedAt).toBe(5_000);
    expect(positionState(row).status).toBe('closed');
  });

  it('is idempotent across re-decode: re-upserted events do not double-apply', () => {
    const { db } = createTestDb();
    upsertEvents(db, uniLifecycle());
    rebuildPositions(db, [UNI_POS]);
    const first = getPosition(db, UNI_POS)!;

    // Simulate a re-decode of the same txs: same unique keys, same payload.
    upsertEvents(db, uniLifecycle());
    rebuildPositions(db, [UNI_POS]);
    rebuildPositions(db, [UNI_POS]); // and a rebuild with no new data at all

    const second = getPosition(db, UNI_POS)!;
    expect(second).toEqual(first);
  });

  it('reflects a corrected handler re-decode (changed amounts) after rebuild', () => {
    const { db } = createTestDb();
    upsertEvents(db, uniLifecycle().slice(0, 2));
    rebuildPositions(db, [UNI_POS]);

    // Re-decode emits the same (chain, tx, log, seq) key with a corrected amount.
    upsertEvents(db, [
      lpEvent({
        type: 'lp_deposit',
        subtype: 'open_position',
        txHash: '0xopen',
        timestamp: 1_000,
        logIndex: 10,
        sentAsset: 'WETH',
        sentAmount: 2_000_000_000_000_000_000n,
      }),
    ]);
    rebuildPositions(db, [UNI_POS]);

    expect(positionState(getPosition(db, UNI_POS)!).deposited).toEqual({
      USDC: '2500000000',
      WETH: '2000000000000000000',
    });
  });

  it('deletes the position row when its events disappear', () => {
    const { db } = createTestDb();
    upsertEvents(db, uniLifecycle().slice(0, 2));
    rebuildPositions(db, [UNI_POS]);
    expect(getPosition(db, UNI_POS)).toBeDefined();

    deleteEventsByTx(db, 'base', '0xopen');
    const result = rebuildPositions(db, [UNI_POS]);
    expect(result).toEqual({ upserted: 0, deleted: 1 });
    expect(getPosition(db, UNI_POS)).toBeUndefined();
  });

  it('rebuildAllPositions discovers every positionId and clears stale rows', () => {
    const { db } = createTestDb();
    upsertEvents(db, [...uniLifecycle().slice(0, 2), turbosOpen()]);
    // Stale row with no backing events (e.g., left over from an older decode).
    db.insert(positions)
      .values({
        positionId: 'base:uniswap_v3:999',
        chain: 'base',
        protocol: 'uniswap_v3',
        wallet: 'wallet-rabby',
        openedAt: 1,
      })
      .run();

    const result = rebuildAllPositions(db);
    expect(result).toEqual({ upserted: 2, deleted: 1 });
    expect(listPositions(db).map((p) => p.positionId).sort()).toEqual(
      [TURBOS_POS, UNI_POS].sort(),
    );
  });

  it('syncPositionsForEvents rebuilds only the positions in the decoded batch', () => {
    const { db } = createTestDb();
    upsertEvents(db, [...uniLifecycle().slice(0, 2), turbosOpen()]);

    const result = syncPositionsForEvents(db, [
      { positionId: UNI_POS },
      { positionId: UNI_POS }, // duplicates collapse
      { positionId: null }, // events without a position are ignored
      {},
    ]);

    expect(result).toEqual({ upserted: 1, deleted: 0 });
    expect(getPosition(db, UNI_POS)).toBeDefined();
    expect(getPosition(db, TURBOS_POS)).toBeUndefined();
  });

  it('persists a rebalance as one closed and one open position', () => {
    const { db } = createTestDb();
    upsertEvents(db, [
      lpEvent({
        type: 'lp_deposit',
        subtype: 'open_position',
        txHash: '0xopen',
        timestamp: 1_000,
        logIndex: 1,
        sentAsset: 'WETH',
        sentAmount: 10n,
      }),
      lpEvent({
        type: 'lp_withdraw',
        subtype: 'close_position',
        txHash: '0xrebal',
        timestamp: 5_000,
        logIndex: 10,
        receivedAsset: 'WETH',
        receivedAmount: 9n,
      }),
      lpEvent({
        positionId: UNI_POS_2,
        type: 'lp_deposit',
        subtype: 'open_position',
        txHash: '0xrebal',
        timestamp: 5_000,
        logIndex: 20,
        sentAsset: 'WETH',
        sentAmount: 9n,
      }),
    ]);

    rebuildAllPositions(db);

    expect(getPosition(db, UNI_POS)!.closedAt).toBe(5_000);
    expect(getPosition(db, UNI_POS_2)!.closedAt).toBeNull();
    expect(positionState(getPosition(db, UNI_POS_2)!).deposited).toEqual({ WETH: '9' });
  });

  it('listPositions filters by open state, chain and wallet', () => {
    const { db } = createTestDb();
    upsertEvents(db, [...uniLifecycle(), turbosOpen()]); // UNI closed, TURBOS open
    rebuildAllPositions(db);

    expect(listPositions(db)).toHaveLength(2);
    expect(listPositions(db, { openOnly: true }).map((p) => p.positionId)).toEqual([TURBOS_POS]);
    expect(listPositions(db, { chain: 'sui' }).map((p) => p.positionId)).toEqual([TURBOS_POS]);
    expect(listPositions(db, { wallet: 'wallet-rabby' }).map((p) => p.positionId)).toEqual([
      UNI_POS,
    ]);
    expect(listPositions(db, { chain: 'base', openOnly: true })).toHaveLength(0);
  });
});
