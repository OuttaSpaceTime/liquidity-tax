import { describe, it, expect } from 'bun:test';
import { createTestDb } from '../helpers/db';
import { fixturePath } from './helpers';
import { importEurCache, EUR_CACHE_SOURCE } from '../../src/prices/import-eur-cache';
import { upsertPrices, getPrice, countPrices } from '../../src/prices/repo';

// Real slice of liquidity-sheets eur_price_cache.json (see capture.ts):
//   ethereum: 2025-07-04 (close 2138.75 EUR), 2025-07-13 (close 2536.66 EUR)
//   weth:     2025-07-31 — stale CryptoCompare feed, deliberately unmapped
//   carrot:   2026-03-17 — empty prices array
const SAMPLE = fixturePath('eur-cache-sample.json');

function fakeLlama(price: number | null) {
  const calls: Array<{ cgId: string; date: string }> = [];
  return {
    calls,
    defillama: {
      fetchUsdClose: (cgId: string, date: string) => {
        calls.push({ cgId, date });
        return Promise.resolve(price);
      },
    },
  };
}

describe('importEurCache', () => {
  it('seeds prices from the cache: EUR daily close + DefiLlama USD, for every mapped symbol', async () => {
    const { db } = createTestDb();
    const { defillama, calls } = fakeLlama(2200);

    const summary = await importEurCache(db, SAMPLE, { defillama });

    // ethereum prices both ETH and WETH (1:1 wrap alias).
    expect(getPrice(db, 'ETH', '2025-07-04')).toMatchObject({
      eurPrice: 2138.75,
      usdPrice: 2200,
      source: EUR_CACHE_SOURCE,
    });
    expect(getPrice(db, 'WETH', '2025-07-04')?.eurPrice).toBe(2138.75);
    expect(getPrice(db, 'ETH', '2025-07-13')?.eurPrice).toBe(2536.66);
    expect(countPrices(db)).toBe(4); // {ETH, WETH} x {07-04, 07-13}
    expect(calls).toEqual([
      { cgId: 'ethereum', date: '2025-07-04' },
      { cgId: 'ethereum', date: '2025-07-13' },
    ]);
    expect(summary).toMatchObject({ written: 4, defillamaCalls: 2, skippedEmpty: 1 });
  });

  it('reports cache ids with no mapped symbol instead of importing them', async () => {
    const { db } = createTestDb();
    const { defillama } = fakeLlama(2200);

    const summary = await importEurCache(db, SAMPLE, { defillama });

    // 'weth' is the stale CryptoCompare feed id — its 31 cache days must not
    // become WETH rows (WETH is priced via 'ethereum').
    expect(summary.unmappedIds).toEqual(['weth']);
    expect(getPrice(db, 'WETH', '2025-07-31')).toBeUndefined();
  });

  it('skips days whose EUR series is empty', async () => {
    const { db } = createTestDb();
    const { defillama, calls } = fakeLlama(2200);

    const summary = await importEurCache(db, SAMPLE, { defillama });

    expect(summary.skippedEmpty).toBe(1); // carrot/2026-03-17
    expect(calls.find((c) => c.cgId === 'carrot')).toBeUndefined();
  });

  it('skips a pair when DefiLlama has no USD close (usd_price is NOT NULL)', async () => {
    const { db } = createTestDb();
    const { defillama } = fakeLlama(null);

    const summary = await importEurCache(db, SAMPLE, { defillama });

    expect(countPrices(db)).toBe(0);
    expect(summary).toMatchObject({ written: 0, skippedNoUsd: 2 });
  });

  it('overwrites USD-only rows (eur_price NULL) instead of skipping them', async () => {
    const { db } = createTestDb();
    // A defillama-sourced backfill row: USD present, EUR missing. The cache
    // import must treat it as missing, not as satisfied.
    upsertPrices(db, [
      { asset: 'ETH', date: '2025-07-04', usdPrice: 2100, eurPrice: null, source: 'defillama' },
    ]);
    const { defillama } = fakeLlama(2200);

    await importEurCache(db, SAMPLE, { defillama });

    expect(getPrice(db, 'ETH', '2025-07-04')).toMatchObject({
      eurPrice: 2138.75,
      source: EUR_CACHE_SOURCE,
    });
  });

  it('is idempotent — already-seeded pairs cost no API calls on re-run', async () => {
    const { db } = createTestDb();
    const first = fakeLlama(2200);
    await importEurCache(db, SAMPLE, { defillama: first.defillama });

    const second = fakeLlama(9999);
    const summary = await importEurCache(db, SAMPLE, { defillama: second.defillama });

    expect(second.calls).toEqual([]);
    expect(summary).toMatchObject({ written: 0, skippedExisting: 2 });
    expect(getPrice(db, 'ETH', '2025-07-04')?.usdPrice).toBe(2200); // untouched
  });

  it('fills only the missing symbols when a pair is partially seeded', async () => {
    const { db } = createTestDb();
    upsertPrices(db, [
      { asset: 'ETH', date: '2025-07-04', usdPrice: 1, eurPrice: 1, source: 'coingecko' },
    ]);
    const { defillama } = fakeLlama(2200);

    await importEurCache(db, SAMPLE, { defillama });

    expect(getPrice(db, 'ETH', '2025-07-04')?.source).toBe('coingecko'); // kept
    expect(getPrice(db, 'WETH', '2025-07-04')?.source).toBe(EUR_CACHE_SOURCE); // filled
  });
});
