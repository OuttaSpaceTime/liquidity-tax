import { describe, it, expect } from 'bun:test';
import { createTestDb } from '../helpers/db';
import { insertEvent } from './helpers';
import { collectNeededPairs, buildFetchPlan } from '../../src/prices/manifest';
import { upsertPrices } from '../../src/prices/repo';

// 2025-07-05 00:00:00 UTC and a later time the same UTC day.
const T0 = 1751673600;
const T0_LATER = T0 + 8 * 3600;

describe('collectNeededPairs (dali-rp2 TransactionManifest pattern)', () => {
  it('collects distinct (asset, UTC date) pairs over sent and received assets', () => {
    const { db } = createTestDb();
    insertEvent(db, { txHash: '0x1', timestamp: T0, sentAsset: 'ETH', receivedAsset: 'USDC' });
    insertEvent(db, {
      txHash: '0x2',
      timestamp: T0_LATER,
      sentAsset: 'USDC',
      receivedAsset: 'ETH',
    });
    expect(collectNeededPairs(db)).toEqual([
      { asset: 'ETH', date: '2025-07-05' },
      { asset: 'USDC', date: '2025-07-05' },
    ]);
  });

  it('splits the same asset across UTC day boundaries', () => {
    const { db } = createTestDb();
    insertEvent(db, { txHash: '0x1', timestamp: T0 - 1, sentAsset: 'ETH' });
    insertEvent(db, { txHash: '0x2', timestamp: T0, sentAsset: 'ETH' });
    expect(collectNeededPairs(db)).toEqual([
      { asset: 'ETH', date: '2025-07-04' },
      { asset: 'ETH', date: '2025-07-05' },
    ]);
  });

  it('excludes pairs already present in the prices table', () => {
    const { db } = createTestDb();
    insertEvent(db, { txHash: '0x1', timestamp: T0, sentAsset: 'ETH', receivedAsset: 'USDC' });
    upsertPrices(db, [
      { asset: 'ETH', date: '2025-07-05', usdPrice: 1, eurPrice: 1, source: 'coingecko' },
    ]);
    expect(collectNeededPairs(db)).toEqual([{ asset: 'USDC', date: '2025-07-05' }]);
  });

  it('returns nothing when events is empty', () => {
    const { db } = createTestDb();
    expect(collectNeededPairs(db)).toEqual([]);
  });
});

describe('buildFetchPlan', () => {
  it('groups assets sharing a CoinGecko id into one fetch task', () => {
    const plan = buildFetchPlan([
      { asset: 'ETH', date: '2025-07-05' },
      { asset: 'WETH', date: '2025-07-05' },
      { asset: 'USDC', date: '2025-07-05' },
    ]);
    expect(plan.tasks).toEqual([
      { cgId: 'ethereum', date: '2025-07-05', assets: ['ETH', 'WETH'] },
      { cgId: 'usd-coin', date: '2025-07-05', assets: ['USDC'] },
    ]);
    expect(plan.unmappedAssets).toEqual([]);
  });

  it('keeps dates apart and sorts tasks by (date, cgId)', () => {
    const plan = buildFetchPlan([
      { asset: 'USDC', date: '2025-07-06' },
      { asset: 'ETH', date: '2025-07-06' },
      { asset: 'ETH', date: '2025-07-05' },
    ]);
    expect(plan.tasks.map((t) => [t.cgId, t.date])).toEqual([
      ['ethereum', '2025-07-05'],
      ['ethereum', '2025-07-06'],
      ['usd-coin', '2025-07-06'],
    ]);
  });

  it('reports assets without a CoinGecko id once, without creating tasks', () => {
    const plan = buildFetchPlan([
      { asset: 'MYSTERY', date: '2025-07-05' },
      { asset: 'MYSTERY', date: '2025-07-06' },
    ]);
    expect(plan.tasks).toEqual([]);
    expect(plan.unmappedAssets).toEqual(['MYSTERY']);
  });
});
