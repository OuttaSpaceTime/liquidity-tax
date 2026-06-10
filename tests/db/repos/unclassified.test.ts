import { describe, it, expect } from 'bun:test';
import { createTestDb } from '../../helpers/db';
import {
  upsertUnclassified,
  resolveUnclassified,
  deleteUnclassified,
  listUnclassified,
  countUnclassifiedByChain,
} from '../../../src/db/repos/unclassified';

function row(overrides: Partial<Parameters<typeof upsertUnclassified>[1]> = {}) {
  return {
    chain: 'base',
    txHash: '0xaaa',
    rawJson: { mystery: true },
    reason: 'no handler matched',
    firstSeenAt: 1_700_000_000,
    ...overrides,
  };
}

describe('unclassified repo', () => {
  it('inserts and lists an unclassified tx', () => {
    const { db } = createTestDb();
    upsertUnclassified(db, row());
    const got = listUnclassified(db);
    expect(got).toHaveLength(1);
    expect(got[0].reason).toBe('no handler matched');
    expect(got[0].resolvedAt).toBeNull();
  });

  it('upsert preserves first_seen_at and clears resolved_at on re-encounter', () => {
    const { db } = createTestDb();
    upsertUnclassified(db, row());
    resolveUnclassified(db, 'base', '0xaaa', 1_700_000_500);
    upsertUnclassified(db, row({ reason: 'still unknown', firstSeenAt: 1_999_999_999 }));
    const got = listUnclassified(db);
    expect(got).toHaveLength(1);
    expect(got[0].firstSeenAt).toBe(1_700_000_000); // preserved, not 1_999_999_999
    expect(got[0].reason).toBe('still unknown');
    expect(got[0].resolvedAt).toBeNull(); // re-opened
  });

  it('resolveUnclassified stamps resolved_at; unresolvedOnly filter hides it', () => {
    const { db } = createTestDb();
    upsertUnclassified(db, row());
    resolveUnclassified(db, 'base', '0xaaa', 1_700_000_999);
    expect(listUnclassified(db)[0].resolvedAt).toBe(1_700_000_999);
    expect(listUnclassified(db, { unresolvedOnly: true })).toHaveLength(0);
  });

  it('deleteUnclassified removes the row (classification path)', () => {
    const { db } = createTestDb();
    upsertUnclassified(db, row());
    deleteUnclassified(db, 'base', '0xaaa');
    expect(listUnclassified(db)).toHaveLength(0);
  });

  it('filters by chain and counts per chain', () => {
    const { db } = createTestDb();
    upsertUnclassified(db, row());
    upsertUnclassified(db, row({ chain: 'sui', txHash: 'sui1' }));
    expect(listUnclassified(db, { chain: 'sui' })).toHaveLength(1);
    expect(countUnclassifiedByChain(db)).toEqual(
      expect.arrayContaining([
        { chain: 'base', count: 1 },
        { chain: 'sui', count: 1 },
      ]),
    );
  });
});
