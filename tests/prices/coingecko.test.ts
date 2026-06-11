import { describe, it, expect } from 'bun:test';
import { CoinGeckoClient, CoinGeckoRateLimitError } from '../../src/prices/coingecko';
import { loadFixture, fakeFetch, fakeSleep } from './helpers';

const OK = loadFixture('coingecko-history-ethereum-close-2026-06-09.json');
const NO_MARKET_DATA = loadFixture('coingecko-history-no-market-data.json');
const NOT_FOUND = loadFixture('coingecko-history-404.json');
const OUT_OF_RANGE = loadFixture('coingecko-history-out-of-range-401.json');
const RATE_LIMITED = { status: 429, body: {} };

function client(responses: Parameters<typeof fakeFetch>[0], opts: { now?: () => number } = {}) {
  const { fetchFn, requests } = fakeFetch(responses);
  const { sleep, sleeps } = fakeSleep();
  const cg = new CoinGeckoClient({
    apiKey: 'test-demo-key',
    fetchFn,
    sleep,
    now: opts.now ?? (() => 0),
  });
  return { cg, requests, sleeps };
}

describe('CoinGeckoClient.fetchDailyClose', () => {
  it('queries /coins/{id}/history at D+1 (daily close = 00:00 UTC snapshot of the next day)', async () => {
    const { cg, requests } = client([OK]);
    await cg.fetchDailyClose('ethereum', '2026-06-09');
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0].url);
    expect(url.origin + url.pathname).toBe(
      'https://api.coingecko.com/api/v3/coins/ethereum/history',
    );
    expect(url.searchParams.get('date')).toBe('10-06-2026');
    expect(url.searchParams.get('localization')).toBe('false');
  });

  it('sends the demo API key header', async () => {
    const { cg, requests } = client([OK]);
    await cg.fetchDailyClose('ethereum', '2026-06-09');
    expect(requests[0].headers['x-cg-demo-api-key']).toBe('test-demo-key');
  });

  it('returns both EUR and USD from one call', async () => {
    const { cg } = client([OK]);
    const res = await cg.fetchDailyClose('ethereum', '2026-06-09');
    expect(res).toEqual({
      status: 'ok',
      usd: 1637.8350754267938,
      eur: 1419.883448434524,
    });
  });

  it('maps a 404 to unavailable/not_found', async () => {
    const { cg } = client([NOT_FOUND]);
    const res = await cg.fetchDailyClose('this-coin-does-not-exist-xyz', '2026-06-09');
    expect(res).toEqual({ status: 'unavailable', reason: 'not_found' });
  });

  it('maps a 200 without market_data (date predates listing) to unavailable/no_market_data', async () => {
    const { cg } = client([NO_MARKET_DATA]);
    const res = await cg.fetchDailyClose('pump-fun', '2025-06-30');
    expect(res).toEqual({ status: 'unavailable', reason: 'no_market_data' });
  });

  it('maps the demo-tier 365-day-window 401 (error 10012) to unavailable/out_of_range', async () => {
    const { cg } = client([OUT_OF_RANGE]);
    const res = await cg.fetchDailyClose('ethereum', '2025-01-01');
    expect(res).toEqual({ status: 'unavailable', reason: 'out_of_range' });
  });

  it('spaces consecutive calls by 2.5s', async () => {
    const { cg, sleeps } = client([OK, OK]);
    await cg.fetchDailyClose('ethereum', '2026-06-09');
    await cg.fetchDailyClose('ethereum', '2026-06-08');
    expect(sleeps).toEqual([2500]);
  });

  it('backs off 60s on a 429 and retries', async () => {
    const { cg, sleeps, requests } = client([RATE_LIMITED, OK]);
    const res = await cg.fetchDailyClose('ethereum', '2026-06-09');
    expect(res.status).toBe('ok');
    expect(requests).toHaveLength(2);
    expect(sleeps).toContain(60000);
  });

  it('gives up after 3 attempts of 429 with a CoinGeckoRateLimitError', async () => {
    const { cg, requests } = client([RATE_LIMITED]);
    await expect(cg.fetchDailyClose('ethereum', '2026-06-09')).rejects.toBeInstanceOf(
      CoinGeckoRateLimitError,
    );
    expect(requests).toHaveLength(3);
  });
});
