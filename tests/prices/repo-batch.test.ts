import { describe, it, expect } from 'bun:test';
import { createTestDb } from '../helpers/db';
import { upsertPrices, getPricesForPairs, getLatestPrices, priceKey } from '../../src/prices/repo';

describe('getPricesForPairs', () => {
  it('batch-resolves (asset, date) pairs into a map and skips misses', () => {
    const { db } = createTestDb();
    upsertPrices(db, [
      { asset: 'ETH', date: '2026-06-09', usdPrice: 1600, eurPrice: 1400, source: 'cg' },
      { asset: 'USDC', date: '2026-06-09', usdPrice: 1, eurPrice: 0.92, source: 'cg' },
      { asset: 'ETH', date: '2026-06-10', usdPrice: 1650, eurPrice: 1430, source: 'cg' },
    ]);
    const map = getPricesForPairs(db, [
      { asset: 'ETH', date: '2026-06-09' },
      { asset: 'USDC', date: '2026-06-09' },
      { asset: 'ETH', date: '2026-06-11' }, // missing
    ]);
    expect(map.get(priceKey('ETH', '2026-06-09'))?.eurPrice).toBe(1400);
    expect(map.get(priceKey('USDC', '2026-06-09'))?.usdPrice).toBe(1);
    expect(map.has(priceKey('ETH', '2026-06-11'))).toBe(false);
    expect(map.size).toBe(2);
  });

  it('returns an empty map for no pairs', () => {
    const { db } = createTestDb();
    expect(getPricesForPairs(db, []).size).toBe(0);
  });
});

describe('getLatestPrices', () => {
  it('returns the most-recent-date row per asset', () => {
    const { db } = createTestDb();
    upsertPrices(db, [
      { asset: 'ETH', date: '2026-06-09', usdPrice: 1600, eurPrice: 1400, source: 'cg' },
      { asset: 'ETH', date: '2026-06-11', usdPrice: 1700, eurPrice: 1480, source: 'cg' },
      { asset: 'SUI', date: '2026-06-10', usdPrice: 3, eurPrice: 2.7, source: 'cg' },
    ]);
    const map = getLatestPrices(db, ['ETH', 'SUI', 'NOPE']);
    expect(map.get('ETH')?.date).toBe('2026-06-11');
    expect(map.get('ETH')?.usdPrice).toBe(1700);
    expect(map.get('SUI')?.date).toBe('2026-06-10');
    expect(map.has('NOPE')).toBe(false);
  });
});
