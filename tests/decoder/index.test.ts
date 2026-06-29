import { describe, it, expect } from 'bun:test';
import { createTestDb } from '../helpers/db';
import { createDefaultRegistry } from '../../src/decoder';
import { makeRawTx, insertRawTx } from './helpers';

describe('createDefaultRegistry — explicit registration list', () => {
  it('registers all 9 protocol handlers', () => {
    const { db } = createTestDb();
    const registry = createDefaultRegistry(db);
    expect(registry.handlerIds().sort()).toEqual([
      'aave_v3',
      'aerodrome',
      'kamino',
      'morpho',
      'navi',
      'orca_whirlpool',
      'suilend',
      'turbos',
      'uniswap_v3',
    ]);
  });

  it('no handler matches an unrelated tx — it falls through to unclassified', () => {
    const { db } = createTestDb();
    const registry = createDefaultRegistry(db);
    for (const chain of ['base', 'solana', 'sui'] as const) {
      const txHash = `stub-${chain}`;
      insertRawTx(db, makeRawTx({ chain, txHash }));
      const result = registry.decodeAndPersist(chain, txHash);
      expect(result.status).toBe('unclassified');
    }
  });
});
