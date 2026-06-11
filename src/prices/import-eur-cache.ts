import { readFileSync } from 'node:fs';
import type { Db } from '../db/client';
import type { DefiLlamaClient } from './defillama';
import { assetsForCoingeckoId } from './token-map';
import { getPrice, upsertPrices } from './repo';

/**
 * Seed the prices table from the liquidity-sheets EUR price cache
 * (tax-report-2025/04-eur-pricing/eur_price_cache.json) — EUR dailies already
 * fetched there, so importing them saves CoinGecko quota.
 *
 * Cache shape: { [coingeckoId]: { [YYYY-MM-DD]: { prices: [tsMs, eur][] } } }
 * (hourly EUR closes; the last point of a day is timestamped 00:00 UTC of the
 * next day = the daily close, matching this module's price convention).
 *
 * prices.usd_price is NOT NULL, so each imported EUR close is paired with a
 * USD close from DefiLlama (keyless). Pairs without a confident USD price are
 * skipped and reported.
 */

/** EUR close from the sheets CryptoCompare cache + USD close from DefiLlama. */
export const EUR_CACHE_SOURCE = 'eur-cache+defillama';

/**
 * The sheets cache predates the token-map id fixes: 'carrot' and
 * 'navi-protocol' were py-era ids that 404 on today's CoinGecko (and on
 * DefiLlama's coingecko: routing). Translate them to the verified current ids
 * before symbol lookup and the DefiLlama USD fetch.
 */
const LEGACY_CG_IDS: Readonly<Record<string, string>> = {
  carrot: 'carrot-2',
  'navi-protocol': 'navi',
};

export type EurCacheFile = Record<string, Record<string, { prices: [number, number][] }>>;

export interface ImportSummary {
  cacheIds: number;
  cachePairs: number;
  written: number;
  defillamaCalls: number;
  skippedEmpty: number;
  skippedExisting: number;
  skippedNoUsd: number;
  /** Cache ids no asset symbol maps to (e.g. 'weth' — a stale CC feed). */
  unmappedIds: string[];
}

export async function importEurCache(
  db: Db,
  cachePath: string,
  deps: { defillama: Pick<DefiLlamaClient, 'fetchUsdClose'>; log?: (msg: string) => void },
): Promise<ImportSummary> {
  const log = deps.log ?? (() => undefined);
  const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as EurCacheFile;

  const summary: ImportSummary = {
    cacheIds: Object.keys(cache).length,
    cachePairs: 0,
    written: 0,
    defillamaCalls: 0,
    skippedEmpty: 0,
    skippedExisting: 0,
    skippedNoUsd: 0,
    unmappedIds: [],
  };

  for (const cacheId of Object.keys(cache).sort()) {
    const cgId = LEGACY_CG_IDS[cacheId] ?? cacheId;
    const assets = assetsForCoingeckoId(cgId);
    if (assets.length === 0) {
      summary.unmappedIds.push(cacheId);
      continue;
    }
    for (const date of Object.keys(cache[cacheId]).sort()) {
      summary.cachePairs += 1;
      const points = cache[cacheId][date].prices;
      if (points.length === 0) {
        summary.skippedEmpty += 1;
        continue;
      }
      // USD-only rows (eur_price NULL, e.g. the DefiLlama backfill fallback)
      // count as missing: the cache's whole point is supplying the EUR close.
      const missing = assets.filter((asset) => {
        const row = getPrice(db, asset, date);
        return row === undefined || row.eurPrice === null;
      });
      if (missing.length === 0) {
        summary.skippedExisting += 1;
        continue;
      }
      // Daily close = the latest point of the day (00:00 UTC of date+1).
      const eur = points.reduce((a, b) => (b[0] > a[0] ? b : a))[1];

      summary.defillamaCalls += 1;
      const usd = await deps.defillama.fetchUsdClose(cgId, date);
      if (usd === null) {
        summary.skippedNoUsd += 1;
        log(`skip  ${cgId} ${date} — no DefiLlama USD close (usd_price is NOT NULL)`);
        continue;
      }

      upsertPrices(
        db,
        missing.map((asset) => ({
          asset,
          date,
          usdPrice: usd,
          eurPrice: eur,
          source: EUR_CACHE_SOURCE,
        })),
      );
      summary.written += missing.length;
      log(`seed  ${cgId} ${date} → ${missing.join(', ')} (eur ${eur}, usd ${usd})`);
    }
  }

  summary.unmappedIds.sort();
  return summary;
}
