import { describe, it, expect } from 'bun:test';
import { DefiLlamaClient } from '../../src/prices/defillama';
import { loadFixture, fakeFetch, fakeSleep } from './helpers';

const OK = loadFixture('defillama-historical-ethereum.json');
const MISSING = loadFixture('defillama-historical-missing.json');
const LOW_CONFIDENCE = loadFixture('defillama-historical-low-confidence.edited.json');

function client(responses: Parameters<typeof fakeFetch>[0]) {
  const { fetchFn, requests } = fakeFetch(responses);
  const { sleep, sleeps } = fakeSleep();
  const llama = new DefiLlamaClient({ fetchFn, sleep, now: () => 0 });
  return { llama, requests, sleeps };
}

describe('DefiLlamaClient.fetchUsdClose', () => {
  it('queries prices/historical at 00:00 UTC of D+1 with a coingecko: id', async () => {
    const { llama, requests } = client([OK]);
    await llama.fetchUsdClose('ethereum', '2025-01-01');
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0].url);
    // 1735776000 = 2025-01-02T00:00:00Z — the daily close of 2025-01-01.
    expect(url.origin + url.pathname).toBe(
      'https://coins.llama.fi/prices/historical/1735776000/coingecko:ethereum',
    );
    expect(url.searchParams.get('searchWidth')).toBe('4h');
  });

  it('returns the USD price', async () => {
    const { llama } = client([OK]);
    expect(await llama.fetchUsdClose('ethereum', '2025-01-01')).toBe(3352.51);
  });

  it('returns null when the coin is missing from the response', async () => {
    const { llama } = client([MISSING]);
    expect(await llama.fetchUsdClose('this-coin-does-not-exist-xyz', '2025-01-01')).toBeNull();
  });

  it('rejects low-confidence prices (rotki MIN_DEFILLAMA_CONFIDENCE = 0.2)', async () => {
    const { llama } = client([LOW_CONFIDENCE]);
    expect(await llama.fetchUsdClose('ethereum', '2025-01-01')).toBeNull();
  });

  it('returns null on a non-200 response', async () => {
    const { llama } = client([{ status: 500, body: {} }]);
    expect(await llama.fetchUsdClose('ethereum', '2025-01-01')).toBeNull();
  });

  it('spaces consecutive calls', async () => {
    const { llama, sleeps } = client([OK, OK]);
    await llama.fetchUsdClose('ethereum', '2025-01-01');
    await llama.fetchUsdClose('ethereum', '2025-01-02');
    expect(sleeps).toEqual([250]);
  });
});
