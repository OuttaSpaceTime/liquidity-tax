import { describe, it, expect } from 'bun:test';
import { createTestDb } from '../helpers/db';
import { upsertEvents } from '../../src/db/repos/events';
import { listPositions, rebuildAllPositions } from '../../src/positions/repo';
import { lpEvent, uniLifecycle, TURBOS_POS, UNI_POS } from './helpers';

function turbosOpen() {
  return lpEvent({
    positionId: TURBOS_POS,
    chain: 'sui',
    wallet: 'wallet-phantom-sui',
    type: 'lp_deposit',
    subtype: 'open_position',
    txHash: 'digest-open',
    timestamp: 7_000,
    sentAsset: 'SUI',
    sentAmount: 42n,
  });
}

describe('listPositions extended options', () => {
  it('closedOnly returns only positions with a closedAt', () => {
    const { db } = createTestDb();
    upsertEvents(db, [...uniLifecycle(), turbosOpen()]); // UNI closed, TURBOS open
    rebuildAllPositions(db);

    expect(listPositions(db, { closedOnly: true }).map((p) => p.positionId)).toEqual([UNI_POS]);
    expect(listPositions(db, { openOnly: true }).map((p) => p.positionId)).toEqual([TURBOS_POS]);
  });

  it("orderBy 'closed_desc' sorts most-recently-closed first", () => {
    const { db } = createTestDb();
    // Two closed positions with different close times.
    upsertEvents(db, [
      lpEvent({ type: 'lp_deposit', subtype: 'open_position', txHash: '0xo1', timestamp: 1_000, logIndex: 1, sentAsset: 'WETH', sentAmount: 1n }),
      lpEvent({ type: 'lp_withdraw', subtype: 'close_position', txHash: '0xc1', timestamp: 2_000, logIndex: 2, receivedAsset: 'WETH', receivedAmount: 1n }),
      lpEvent({ positionId: 'base:uniswap_v3:other', type: 'lp_deposit', subtype: 'open_position', txHash: '0xo2', timestamp: 1_500, logIndex: 1, sentAsset: 'WETH', sentAmount: 1n }),
      lpEvent({ positionId: 'base:uniswap_v3:other', type: 'lp_withdraw', subtype: 'close_position', txHash: '0xc2', timestamp: 9_000, logIndex: 2, receivedAsset: 'WETH', receivedAmount: 1n }),
    ]);
    rebuildAllPositions(db);

    const ordered = listPositions(db, { closedOnly: true, orderBy: 'closed_desc' });
    expect(ordered.map((p) => p.closedAt)).toEqual([9_000, 2_000]);
  });

  it('limit caps the result count', () => {
    const { db } = createTestDb();
    upsertEvents(db, [...uniLifecycle(), turbosOpen()]);
    rebuildAllPositions(db);
    expect(listPositions(db, { limit: 1 })).toHaveLength(1);
  });
});
