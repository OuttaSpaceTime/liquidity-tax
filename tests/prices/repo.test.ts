import { describe, it, expect } from 'bun:test';
import { createTestDb } from '../helpers/db';
import { upsertPrices, getPrice, countPrices } from '../../src/prices/repo';

describe('prices repo', () => {
  it('inserts and reads back a (asset, date) row with both currencies', () => {
    const { db } = createTestDb();
    upsertPrices(db, [
      {
        asset: 'ETH',
        date: '2026-06-09',
        usdPrice: 1637.84,
        eurPrice: 1419.88,
        source: 'coingecko',
      },
    ]);
    const row = getPrice(db, 'ETH', '2026-06-09');
    expect(row).toMatchObject({
      asset: 'ETH',
      date: '2026-06-09',
      usdPrice: 1637.84,
      eurPrice: 1419.88,
      source: 'coingecko',
    });
  });

  it('allows a null eur_price (DefiLlama fallback rows are USD-only)', () => {
    const { db } = createTestDb();
    upsertPrices(db, [
      { asset: 'CRT', date: '2026-03-17', usdPrice: 0.5, eurPrice: null, source: 'defillama' },
    ]);
    expect(getPrice(db, 'CRT', '2026-03-17')?.eurPrice).toBeNull();
  });

  it('upsert is idempotent on (asset, date) and refreshes the payload', () => {
    const { db } = createTestDb();
    upsertPrices(db, [
      { asset: 'ETH', date: '2026-06-09', usdPrice: 1, eurPrice: null, source: 'defillama' },
    ]);
    upsertPrices(db, [
      {
        asset: 'ETH',
        date: '2026-06-09',
        usdPrice: 1637.84,
        eurPrice: 1419.88,
        source: 'coingecko',
      },
    ]);
    expect(countPrices(db)).toBe(1);
    const row = getPrice(db, 'ETH', '2026-06-09');
    expect(row?.usdPrice).toBe(1637.84);
    expect(row?.eurPrice).toBe(1419.88);
    expect(row?.source).toBe('coingecko');
  });

  it('returns undefined for missing rows', () => {
    const { db } = createTestDb();
    expect(getPrice(db, 'ETH', '1970-01-01')).toBeUndefined();
  });
});
