import type { Db } from '../db/client';
import type { CoinGeckoClient } from './coingecko';
import { CoinGeckoRateLimitError } from './coingecko';
import type { DefiLlamaClient } from './defillama';
import { utcDateOf } from './dates';
import { buildFetchPlan, collectEurMissingPairs, collectNeededPairs } from './manifest';
import { upsertPrices, type PriceInsert } from './repo';

export interface BackfillDeps {
  coingecko: Pick<CoinGeckoClient, 'fetchDailyClose'>;
  defillama: Pick<DefiLlamaClient, 'fetchUsdClose'>;
  /** UTC date used to decide which daily closes are final; default: now. */
  todayUtc?: string;
  log?: (msg: string) => void;
}

export interface BackfillSummary {
  /** Distinct (asset, date) pairs in events that had no prices row. */
  neededPairs: number;
  /** Deduped fetch tasks (aliased assets share one task). */
  tasks: number;
  /** prices rows written. */
  written: number;
  coingeckoCalls: number;
  defillamaCalls: number;
  unmappedAssets: string[];
  /** Pairs whose close (00:00 UTC of date+1) has not happened yet. */
  skippedFutureClose: number;
  /** USD-only rows (eur_price NULL) re-priced via CoinGecko in the second pass. */
  eurRepriced: number;
  failures: Array<{ cgId: string; date: string; reason: string }>;
  stopped: 'completed' | 'max_calls' | 'rate_limited';
}

/**
 * Fill the prices table for every (asset, date) the events table references.
 *
 * Per task: one CoinGecko `/history` call yields BOTH the EUR and USD daily
 * close (source 'coingecko'); when CoinGecko cannot serve the pair, DefiLlama
 * provides a USD-only row (source 'defillama', eur_price NULL — flagged for
 * later EUR re-pricing). `maxCalls` caps total outbound API calls (CoinGecko
 * + DefiLlama); rows are written per task, so an aborted run keeps progress.
 */
export async function backfillPrices(
  db: Db,
  opts: { maxCalls: number },
  deps: BackfillDeps,
): Promise<BackfillSummary> {
  const log = deps.log ?? (() => undefined);
  const todayUtc = deps.todayUtc ?? utcDateOf(Date.now() / 1000);

  const needed = collectNeededPairs(db);
  // A close for date D is final once 00:00 UTC of D+1 has passed, i.e. D < today.
  const fetchable = needed.filter((p) => p.date < todayUtc);
  const plan = buildFetchPlan(fetchable);

  const summary: BackfillSummary = {
    neededPairs: needed.length,
    tasks: plan.tasks.length,
    written: 0,
    coingeckoCalls: 0,
    defillamaCalls: 0,
    unmappedAssets: plan.unmappedAssets,
    skippedFutureClose: needed.length - fetchable.length,
    eurRepriced: 0,
    failures: [],
    stopped: 'completed',
  };
  const callsLeft = () => opts.maxCalls - summary.coingeckoCalls - summary.defillamaCalls;

  for (const task of plan.tasks) {
    if (callsLeft() <= 0) {
      summary.stopped = 'max_calls';
      break;
    }

    let rows: PriceInsert[];
    try {
      summary.coingeckoCalls += 1;
      const res = await deps.coingecko.fetchDailyClose(task.cgId, task.date);
      if (res.status === 'ok') {
        rows = task.assets.map((asset) => ({
          asset,
          date: task.date,
          usdPrice: res.usd,
          eurPrice: res.eur,
          source: 'coingecko',
        }));
      } else {
        if (callsLeft() <= 0) {
          summary.stopped = 'max_calls';
          break;
        }
        summary.defillamaCalls += 1;
        const usd = await deps.defillama.fetchUsdClose(task.cgId, task.date);
        if (usd === null) {
          summary.failures.push({
            cgId: task.cgId,
            date: task.date,
            reason: `coingecko:${res.reason} defillama:no_price`,
          });
          log(`miss  ${task.cgId} ${task.date} (${res.reason}, no DefiLlama price)`);
          continue;
        }
        rows = task.assets.map((asset) => ({
          asset,
          date: task.date,
          usdPrice: usd,
          eurPrice: null,
          source: 'defillama',
        }));
      }
    } catch (err) {
      if (err instanceof CoinGeckoRateLimitError) {
        log(`rate-limited — stopping (${task.cgId} ${task.date})`);
        summary.stopped = 'rate_limited';
        break;
      }
      summary.failures.push({
        cgId: task.cgId,
        date: task.date,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    upsertPrices(db, rows);
    summary.written += rows.length;
    log(`price ${task.cgId} ${task.date} → ${task.assets.join(', ')} (${rows[0].source})`);
  }

  // Second pass — EUR re-pricing: rows the DefiLlama fallback left USD-only
  // (eur_price NULL) would otherwise NEVER get an EUR close (collectNeededPairs
  // treats any existing row as satisfied). Retry CoinGecko for them; a hit
  // overwrites the whole row (both closes, source 'coingecko').
  const eurMissing = collectEurMissingPairs(db).filter((p) => p.date < todayUtc);
  const eurPlan = buildFetchPlan(eurMissing);
  for (const task of eurPlan.tasks) {
    if (summary.stopped !== 'completed') break;
    if (callsLeft() <= 0) {
      summary.stopped = 'max_calls';
      break;
    }
    summary.coingeckoCalls += 1;
    try {
      const res = await deps.coingecko.fetchDailyClose(task.cgId, task.date);
      if (res.status !== 'ok') {
        summary.failures.push({
          cgId: task.cgId,
          date: task.date,
          reason: `eur_reprice coingecko:${res.reason}`,
        });
        log(`eur-miss ${task.cgId} ${task.date} (${res.reason}) — stays USD-only`);
        continue;
      }
      upsertPrices(
        db,
        task.assets.map((asset) => ({
          asset,
          date: task.date,
          usdPrice: res.usd,
          eurPrice: res.eur,
          source: 'coingecko',
        })),
      );
      summary.eurRepriced += task.assets.length;
      log(`eur   ${task.cgId} ${task.date} → ${task.assets.join(', ')} (repriced)`);
    } catch (err) {
      if (err instanceof CoinGeckoRateLimitError) {
        log(`rate-limited — stopping (${task.cgId} ${task.date})`);
        summary.stopped = 'rate_limited';
        break;
      }
      summary.failures.push({
        cgId: task.cgId,
        date: task.date,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}
