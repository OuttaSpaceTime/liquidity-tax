import { describe, it, expect } from 'bun:test';
import { createTestDb } from '../helpers/db';
import { insertEvent } from './helpers';
import { backfillPrices, type BackfillDeps } from '../../src/prices/backfill';
import { getPrice, countPrices, upsertPrices } from '../../src/prices/repo';
import { CoinGeckoRateLimitError, type HistoryResult } from '../../src/prices/coingecko';

// 2025-07-05 00:00:00 UTC.
const T0 = 1751673600;
const TODAY = '2026-06-11';

type CgResponder = (cgId: string, date: string) => HistoryResult;

function fakeClients(cgResponder: CgResponder, llamaPrice: number | null = null) {
  const cgCalls: Array<{ cgId: string; date: string }> = [];
  const llamaCalls: Array<{ cgId: string; date: string }> = [];
  const deps: BackfillDeps = {
    coingecko: {
      fetchDailyClose: (cgId: string, date: string) => {
        cgCalls.push({ cgId, date });
        return Promise.resolve(cgResponder(cgId, date));
      },
    },
    defillama: {
      fetchUsdClose: (cgId: string, date: string) => {
        llamaCalls.push({ cgId, date });
        return Promise.resolve(llamaPrice);
      },
    },
    todayUtc: TODAY,
  };
  return { deps, cgCalls, llamaCalls };
}

const ok = (usd: number, eur: number): HistoryResult => ({ status: 'ok', usd, eur });

describe('backfillPrices', () => {
  it('re-prices USD-only defillama rows (eur_price NULL) via CoinGecko in a second pass', async () => {
    const { db } = createTestDb();
    // A prior run fell back to DefiLlama: USD present, EUR permanently missing
    // unless someone re-prices it. No events needed — the pass scans prices.
    upsertPrices(db, [
      { asset: 'ETH', date: '2025-07-05', usdPrice: 2000, eurPrice: null, source: 'defillama' },
    ]);
    const { deps, cgCalls } = fakeClients(() => ok(2001, 1801));

    const summary = await backfillPrices(db, { maxCalls: 10 }, deps);

    expect(cgCalls).toEqual([{ cgId: 'ethereum', date: '2025-07-05' }]);
    expect(getPrice(db, 'ETH', '2025-07-05')).toMatchObject({
      usdPrice: 2001,
      eurPrice: 1801,
      source: 'coingecko',
    });
    expect(summary.eurRepriced).toBe(1);
  });

  it('leaves USD-only rows untouched when CoinGecko still cannot serve them', async () => {
    const { db } = createTestDb();
    upsertPrices(db, [
      { asset: 'ETH', date: '2025-07-05', usdPrice: 2000, eurPrice: null, source: 'defillama' },
    ]);
    const { deps } = fakeClients(() => ({ status: 'unavailable', reason: 'out_of_range' }));

    const summary = await backfillPrices(db, { maxCalls: 10 }, deps);

    expect(getPrice(db, 'ETH', '2025-07-05')).toMatchObject({
      usdPrice: 2000,
      eurPrice: null,
      source: 'defillama',
    });
    expect(summary.eurRepriced).toBe(0);
    expect(summary.failures).toHaveLength(1);
  });

  it('writes coingecko rows (both currencies, source=coingecko) for needed pairs', async () => {
    const { db } = createTestDb();
    insertEvent(db, { txHash: '0x1', timestamp: T0, sentAsset: 'ETH', receivedAsset: 'USDC' });
    const { deps, cgCalls } = fakeClients(() => ok(2000, 1800));

    const summary = await backfillPrices(db, { maxCalls: 500 }, deps);

    expect(cgCalls).toEqual([
      { cgId: 'ethereum', date: '2025-07-05' },
      { cgId: 'usd-coin', date: '2025-07-05' },
    ]);
    expect(getPrice(db, 'ETH', '2025-07-05')).toMatchObject({
      usdPrice: 2000,
      eurPrice: 1800,
      source: 'coingecko',
    });
    expect(getPrice(db, 'USDC', '2025-07-05')).toBeDefined();
    expect(summary).toMatchObject({
      written: 2,
      coingeckoCalls: 2,
      defillamaCalls: 0,
      stopped: 'completed',
    });
  });

  it('prices all assets sharing one CoinGecko id with a single call', async () => {
    const { db } = createTestDb();
    insertEvent(db, { txHash: '0x1', timestamp: T0, sentAsset: 'ETH', receivedAsset: 'WETH' });
    const { deps, cgCalls } = fakeClients(() => ok(2000, 1800));

    const summary = await backfillPrices(db, { maxCalls: 500 }, deps);

    expect(cgCalls).toHaveLength(1);
    expect(summary.written).toBe(2);
    expect(getPrice(db, 'WETH', '2025-07-05')?.eurPrice).toBe(1800);
  });

  it('falls back to DefiLlama (USD-only, source=defillama) when CoinGecko is unavailable', async () => {
    const { db } = createTestDb();
    insertEvent(db, { txHash: '0x1', timestamp: T0, sentAsset: 'CRT' });
    const { deps, llamaCalls } = fakeClients(
      () => ({ status: 'unavailable', reason: 'out_of_range' }),
      0.5,
    );

    const summary = await backfillPrices(db, { maxCalls: 500 }, deps);

    expect(llamaCalls).toEqual([{ cgId: 'carrot-2', date: '2025-07-05' }]);
    expect(getPrice(db, 'CRT', '2025-07-05')).toMatchObject({
      usdPrice: 0.5,
      eurPrice: null,
      source: 'defillama',
    });
    expect(summary).toMatchObject({ written: 1, defillamaCalls: 1 });
  });

  it('records a failure when both sources come up empty', async () => {
    const { db } = createTestDb();
    insertEvent(db, { txHash: '0x1', timestamp: T0, sentAsset: 'CRT' });
    const { deps } = fakeClients(() => ({ status: 'unavailable', reason: 'not_found' }), null);

    const summary = await backfillPrices(db, { maxCalls: 500 }, deps);

    expect(countPrices(db)).toBe(0);
    expect(summary.failures).toEqual([
      { cgId: 'carrot-2', date: '2025-07-05', reason: 'coingecko:not_found defillama:no_price' },
    ]);
  });

  it('reports unmapped assets without spending API calls on them', async () => {
    const { db } = createTestDb();
    insertEvent(db, { txHash: '0x1', timestamp: T0, sentAsset: 'MYSTERY' });
    const { deps, cgCalls, llamaCalls } = fakeClients(() => ok(1, 1));

    const summary = await backfillPrices(db, { maxCalls: 500 }, deps);

    expect(cgCalls).toEqual([]);
    expect(llamaCalls).toEqual([]);
    expect(summary.unmappedAssets).toEqual(['MYSTERY']);
  });

  it('skips pairs whose daily close is not final yet (date >= today UTC)', async () => {
    const { db } = createTestDb();
    const todaySec = Date.UTC(2026, 5, 11) / 1000;
    insertEvent(db, { txHash: '0x1', timestamp: todaySec, sentAsset: 'ETH' });
    const { deps, cgCalls } = fakeClients(() => ok(1, 1));

    const summary = await backfillPrices(db, { maxCalls: 500 }, deps);

    expect(cgCalls).toEqual([]);
    expect(summary.skippedFutureClose).toBe(1);
    expect(summary.stopped).toBe('completed');
  });

  it('stops at the --max-calls budget', async () => {
    const { db } = createTestDb();
    insertEvent(db, { txHash: '0x1', timestamp: T0, sentAsset: 'ETH', receivedAsset: 'USDC' });
    const { deps, cgCalls } = fakeClients(() => ok(1, 1));

    const summary = await backfillPrices(db, { maxCalls: 1 }, deps);

    expect(cgCalls).toHaveLength(1);
    expect(summary.stopped).toBe('max_calls');
    expect(countPrices(db)).toBe(1);
  });

  it('counts DefiLlama fallback calls against the budget', async () => {
    const { db } = createTestDb();
    insertEvent(db, { txHash: '0x1', timestamp: T0, sentAsset: 'ETH', receivedAsset: 'USDC' });
    const { deps, llamaCalls } = fakeClients(
      () => ({ status: 'unavailable', reason: 'out_of_range' }),
      1,
    );

    const summary = await backfillPrices(db, { maxCalls: 2 }, deps);

    // Budget of 2: one CG call + one llama call for the first task, then stop.
    expect(llamaCalls).toHaveLength(1);
    expect(summary).toMatchObject({ coingeckoCalls: 1, defillamaCalls: 1, stopped: 'max_calls' });
  });

  it('stops cleanly when CoinGecko exhausts its 429 retries', async () => {
    const { db } = createTestDb();
    insertEvent(db, { txHash: '0x1', timestamp: T0, sentAsset: 'ETH', receivedAsset: 'USDC' });
    const { deps, cgCalls } = fakeClients(() => {
      throw new CoinGeckoRateLimitError('rate limited');
    });

    const summary = await backfillPrices(db, { maxCalls: 500 }, deps);

    expect(cgCalls).toHaveLength(1);
    expect(summary.stopped).toBe('rate_limited');
  });

  it('records unexpected client errors as failures and keeps going', async () => {
    const { db } = createTestDb();
    insertEvent(db, { txHash: '0x1', timestamp: T0, sentAsset: 'ETH', receivedAsset: 'USDC' });
    const { deps, cgCalls } = fakeClients((cgId) => {
      if (cgId === 'ethereum') throw new Error('boom');
      return ok(1, 0.9);
    });

    const summary = await backfillPrices(db, { maxCalls: 10 }, deps);

    // Non-rate-limit errors must not abort the run — the next task still runs.
    expect(cgCalls).toHaveLength(2);
    expect(summary.failures).toEqual([{ cgId: 'ethereum', date: '2025-07-05', reason: 'boom' }]);
    expect(summary).toMatchObject({ written: 1, stopped: 'completed' });
    expect(getPrice(db, 'USDC', '2025-07-05')).toBeDefined();
  });

  it('records unexpected errors during EUR re-pricing without aborting', async () => {
    const { db } = createTestDb();
    upsertPrices(db, [
      { asset: 'ETH', date: '2025-07-05', usdPrice: 2000, eurPrice: null, source: 'defillama' },
    ]);
    const { deps } = fakeClients(() => {
      throw new Error('boom');
    });

    const summary = await backfillPrices(db, { maxCalls: 10 }, deps);

    expect(summary.failures).toEqual([{ cgId: 'ethereum', date: '2025-07-05', reason: 'boom' }]);
    expect(summary).toMatchObject({ eurRepriced: 0, stopped: 'completed' });
    expect(getPrice(db, 'ETH', '2025-07-05')?.source).toBe('defillama');
  });

  it('stops before the DefiLlama fallback when the budget is already spent', async () => {
    const { db } = createTestDb();
    insertEvent(db, { txHash: '0x1', timestamp: T0, sentAsset: 'ETH' });
    const { deps, cgCalls, llamaCalls } = fakeClients(
      () => ({ status: 'unavailable', reason: 'out_of_range' }),
      1,
    );

    const summary = await backfillPrices(db, { maxCalls: 1 }, deps);

    // Budget of 1: the CG miss consumes it; the llama fallback must not fire.
    expect(cgCalls).toHaveLength(1);
    expect(llamaCalls).toEqual([]);
    expect(summary).toMatchObject({ written: 0, stopped: 'max_calls' });
  });

  it('skips the EUR re-pricing pass when the first pass exhausts the budget exactly', async () => {
    const { db } = createTestDb();
    insertEvent(db, { txHash: '0x1', timestamp: T0, sentAsset: 'ETH' });
    upsertPrices(db, [
      { asset: 'USDC', date: '2025-07-05', usdPrice: 1, eurPrice: null, source: 'defillama' },
    ]);
    const { deps, cgCalls } = fakeClients(() => ok(2000, 1800));

    const summary = await backfillPrices(db, { maxCalls: 1 }, deps);

    // First pass completes within budget; the second pass finds zero calls left.
    expect(cgCalls).toEqual([{ cgId: 'ethereum', date: '2025-07-05' }]);
    expect(summary).toMatchObject({ written: 1, eurRepriced: 0, stopped: 'max_calls' });
    expect(getPrice(db, 'USDC', '2025-07-05')?.eurPrice).toBeNull();
  });

  it('stops cleanly when CoinGecko rate-limits during the EUR re-pricing pass', async () => {
    const { db } = createTestDb();
    upsertPrices(db, [
      { asset: 'ETH', date: '2025-07-05', usdPrice: 2000, eurPrice: null, source: 'defillama' },
    ]);
    const { deps, cgCalls } = fakeClients(() => {
      throw new CoinGeckoRateLimitError('rate limited');
    });

    const summary = await backfillPrices(db, { maxCalls: 10 }, deps);

    expect(cgCalls).toHaveLength(1);
    expect(summary).toMatchObject({ eurRepriced: 0, stopped: 'rate_limited' });
    expect(getPrice(db, 'ETH', '2025-07-05')).toMatchObject({
      usdPrice: 2000,
      eurPrice: null,
      source: 'defillama',
    });
  });

  it('is idempotent — a re-run after success makes zero API calls', async () => {
    const { db } = createTestDb();
    insertEvent(db, { txHash: '0x1', timestamp: T0, sentAsset: 'ETH' });
    const first = fakeClients(() => ok(2000, 1800));
    await backfillPrices(db, { maxCalls: 500 }, first.deps);

    const second = fakeClients(() => ok(2000, 1800));
    const summary = await backfillPrices(db, { maxCalls: 500 }, second.deps);

    expect(second.cgCalls).toEqual([]);
    expect(summary).toMatchObject({ neededPairs: 0, written: 0, stopped: 'completed' });
  });
});
