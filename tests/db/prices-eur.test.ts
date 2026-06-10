import { describe, it, expect } from 'bun:test';
import { createTestDb } from '../helpers/db';
import { prices } from '../../db/schema';

describe('prices.eur_price column', () => {
  it('stores eur_price alongside usd_price and allows null', () => {
    const { db } = createTestDb();
    db.insert(prices)
      .values([
        { asset: 'ETH', date: '2026-01-01', usdPrice: 3500.5, eurPrice: 3201.25, source: 'coingecko' },
        { asset: 'SOL', date: '2026-01-01', usdPrice: 250, source: 'coingecko' },
      ])
      .run();
    const rows = db.select().from(prices).all();
    const eth = rows.find((r) => r.asset === 'ETH')!;
    const sol = rows.find((r) => r.asset === 'SOL')!;
    expect(eth.eurPrice).toBe(3201.25);
    expect(eth.usdPrice).toBe(3500.5);
    expect(sol.eurPrice).toBeNull();
  });
});
