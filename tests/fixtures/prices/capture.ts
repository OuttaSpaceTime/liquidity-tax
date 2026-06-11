#!/usr/bin/env bun
/**
 * One-off fixture capture for the price-cache tests. Records REAL API
 * responses to JSON files so tests never make live calls.
 *
 * Run manually (needs COINGECKO_API_KEY in .env): bun tests/fixtures/prices/capture.ts
 *
 * Captured:
 *  - CoinGecko /coins/{id}/history (ok, no-market_data, 404 body)
 *  - DefiLlama /prices/historical/{ts}/{coin} (ok, missing coin)
 *  - a small real slice of liquidity-sheets eur_price_cache.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { requireEnv } from '../../../src/config/env';

const DIR = new URL('.', import.meta.url).pathname;
const CG = 'https://api.coingecko.com/api/v3';
const LLAMA = 'https://coins.llama.fi';
const EUR_CACHE =
  '/home/felix/Code/Misc/defi-tracker/liquidity-sheets/tax-report-2025/04-eur-pricing/eur_price_cache.json';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function captureJson(name: string, url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers });
  const body: unknown = await res.json();
  writeFileSync(`${DIR}${name}`, JSON.stringify({ status: res.status, body }, null, 2) + '\n');
  console.log(`${name}: HTTP ${res.status}`);
}

const cgHeaders = { 'x-cg-demo-api-key': requireEnv('COINGECKO_API_KEY') };

// Daily close of 2026-06-09 = CoinGecko snapshot at 00:00 UTC on 10-06-2026.
// (Demo keys may only query the past 365 days — see the out-of-range fixture.)
await captureJson(
  'coingecko-history-ethereum-close-2026-06-09.json',
  `${CG}/coins/ethereum/history?date=10-06-2026&localization=false`,
  cgHeaders,
);
await sleep(2500);
// Coin exists but the date predates its listing — response carries no market_data key.
// pump-fun (PUMP) launched 2025-07-12; 2025-07-01 is still within the 365-day window.
await captureJson(
  'coingecko-history-no-market-data.json',
  `${CG}/coins/pump-fun/history?date=01-07-2025&localization=false`,
  cgHeaders,
);
await sleep(2500);
await captureJson(
  'coingecko-history-404.json',
  `${CG}/coins/this-coin-does-not-exist-xyz/history?date=10-06-2026&localization=false`,
  cgHeaders,
);
await sleep(2500);
// Demo/public tier: history older than 365 days → HTTP 401, error_code 10012.
await captureJson(
  'coingecko-history-out-of-range-401.json',
  `${CG}/coins/ethereum/history?date=02-01-2025&localization=false`,
  cgHeaders,
);

await captureJson(
  'defillama-historical-ethereum.json',
  `${LLAMA}/prices/historical/1735776000/coingecko:ethereum?searchWidth=4h`,
);
await captureJson(
  'defillama-historical-missing.json',
  `${LLAMA}/prices/historical/1735776000/coingecko:this-coin-does-not-exist-xyz?searchWidth=4h`,
);

// Real slice of the sheets EUR cache: 2 ethereum days + 1 weth day + 1 empty-prices day.
const cache = JSON.parse(readFileSync(EUR_CACHE, 'utf8')) as Record<
  string,
  Record<string, { prices: [number, number][] }>
>;
const sample: Record<string, Record<string, { prices: [number, number][] }>> = {};
const pick = (id: string, days: string[]) => {
  for (const day of days) {
    if (cache[id]?.[day] === undefined) throw new Error(`missing ${id}/${day} in real cache`);
    (sample[id] ??= {})[day] = cache[id][day];
  }
};
const ethDays = Object.keys(cache['ethereum']).sort().slice(0, 2);
pick('ethereum', ethDays);
pick('weth', Object.keys(cache['weth']).sort().slice(0, 1));
outer: for (const [id, days] of Object.entries(cache)) {
  for (const [day, v] of Object.entries(days)) {
    if (v.prices.length === 0) {
      pick(id, [day]);
      console.log(`empty-prices sample: ${id}/${day}`);
      break outer;
    }
  }
}
writeFileSync(`${DIR}eur-cache-sample.json`, JSON.stringify(sample, null, 2) + '\n');
console.log('eur-cache-sample.json written:', Object.keys(sample).join(', '));
