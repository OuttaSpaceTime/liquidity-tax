import { Command } from 'commander';
import { requireEnv } from '../config/env';
import { openDb } from '../db/client';
import { backfillPrices } from './backfill';
import { CoinGeckoClient } from './coingecko';
import { DefiLlamaClient } from './defillama';
import { importEurCache } from './import-eur-cache';

export const DEFAULT_EUR_CACHE_PATH =
  '/home/felix/Code/Misc/defi-tracker/liquidity-sheets/tax-report-2025/04-eur-pricing/eur_price_cache.json';

/**
 * `prices` subcommand tree. Wire into the root CLI with:
 *   program.addCommand(pricesCommand());
 */
export function pricesCommand(): Command {
  const prices = new Command('prices').description(
    'Daily EUR+USD price cache (CoinGecko, DefiLlama fallback)',
  );

  prices
    .command('backfill')
    .description('Fetch daily closes for every (asset, date) in events missing a price')
    .option('--max-calls <n>', 'cap on outbound API calls for this run', '500')
    .action(async (opts: { maxCalls: string }) => {
      const maxCalls = Number.parseInt(opts.maxCalls, 10);
      if (!Number.isFinite(maxCalls) || maxCalls <= 0) {
        prices.error(`--max-calls must be a positive integer, got '${opts.maxCalls}'`);
      }
      const client = openDb();
      try {
        const summary = await backfillPrices(
          client.db,
          { maxCalls },
          {
            coingecko: new CoinGeckoClient({ apiKey: requireEnv('COINGECKO_API_KEY') }),
            defillama: new DefiLlamaClient(),
            log: (msg) => console.log(msg),
          },
        );
        console.log(
          `backfill: ${summary.neededPairs} pairs needed, ${summary.tasks} fetch tasks → ` +
            `${summary.written} rows written ` +
            `(${summary.coingeckoCalls} coingecko + ${summary.defillamaCalls} defillama calls, ` +
            `${summary.stopped})`,
        );
        if (summary.skippedFutureClose > 0) {
          console.log(`  ${summary.skippedFutureClose} pairs skipped — daily close not final yet`);
        }
        if (summary.unmappedAssets.length > 0) {
          console.log(
            `  unmapped assets (extend token-map.ts): ${summary.unmappedAssets.join(', ')}`,
          );
        }
        for (const f of summary.failures) {
          console.log(`  failed: ${f.cgId} ${f.date} — ${f.reason}`);
        }
      } finally {
        client.close();
      }
    });

  prices
    .command('import-eur-cache')
    .description('Seed prices from the liquidity-sheets EUR daily-close cache (saves quota)')
    .argument('[path]', 'path to eur_price_cache.json', DEFAULT_EUR_CACHE_PATH)
    .action(async (path: string) => {
      const client = openDb();
      try {
        const summary = await importEurCache(client.db, path, {
          defillama: new DefiLlamaClient(),
          log: (msg) => console.log(msg),
        });
        console.log(
          `import: ${summary.cachePairs} cached pairs across ${summary.cacheIds} coins → ` +
            `${summary.written} rows written (${summary.defillamaCalls} defillama calls)`,
        );
        console.log(
          `  skipped: ${summary.skippedExisting} already priced, ` +
            `${summary.skippedEmpty} empty, ${summary.skippedNoUsd} without USD close`,
        );
        if (summary.unmappedIds.length > 0) {
          console.log(`  unmapped cache ids (ignored): ${summary.unmappedIds.join(', ')}`);
        }
      } finally {
        client.close();
      }
    });

  return prices;
}
