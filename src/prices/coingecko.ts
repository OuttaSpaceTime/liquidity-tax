import { coingeckoHistoryDateOf } from './dates';

/**
 * CoinGecko demo-tier client for daily closes.
 *
 * Endpoint semantics mirrored from rotki
 * (rotkehlchen/externalapis/coingecko.py — `/coins/{id}/history?date=DD-MM-YYYY`
 * returns `market_data.current_price` as a per-currency map, snapshotted at
 * 00:00 UTC of the requested date) and BittyTax (x-cg-demo-api-key header on
 * the public base URL).
 *
 * Demo-tier quirk (captured in tests/fixtures/prices/coingecko-history-out-of-range-401.json):
 * history older than 365 days answers HTTP 401 with error_code 10012 — treated
 * as `unavailable/out_of_range` so callers can fall back to DefiLlama.
 */

export type HistoryResult =
  | { status: 'ok'; usd: number; eur: number }
  | { status: 'unavailable'; reason: 'not_found' | 'no_market_data' | 'out_of_range' };

export class CoinGeckoRateLimitError extends Error {}

export interface CoinGeckoClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Minimum spacing between calls; default 2.5s (~24/min, safely under the 30/min demo cap). */
  spacingMs?: number;
  /** Wait after a 429 before retrying; default 60s. */
  backoffMs?: number;
  /** Total request attempts per fetch before giving up on 429s; default 3. */
  maxAttempts?: number;
}

interface HistoryBody {
  market_data?: { current_price?: Record<string, number> };
  error?: { status?: { error_code?: number } };
  status?: { error_code?: number };
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CoinGeckoClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly spacingMs: number;
  private readonly backoffMs: number;
  private readonly maxAttempts: number;
  private lastCallAt = Number.NEGATIVE_INFINITY;

  constructor(opts: CoinGeckoClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://api.coingecko.com/api/v3';
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
    this.spacingMs = opts.spacingMs ?? 2500;
    this.backoffMs = opts.backoffMs ?? 60000;
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  /** Daily close (00:00 UTC of date+1) of one coin in EUR and USD — one call. */
  async fetchDailyClose(cgId: string, date: string): Promise<HistoryResult> {
    const url =
      `${this.baseUrl}/coins/${encodeURIComponent(cgId)}/history` +
      `?date=${coingeckoHistoryDateOf(date)}&localization=false`;

    for (let attempt = 1; ; attempt += 1) {
      const res = await this.rateLimitedGet(url);
      if (res.status === 429) {
        if (attempt >= this.maxAttempts) {
          throw new CoinGeckoRateLimitError(
            `CoinGecko still rate-limiting after ${attempt} attempts (${cgId} ${date})`,
          );
        }
        await this.sleep(this.backoffMs);
        continue;
      }
      return this.parse(res, cgId, date);
    }
  }

  private async rateLimitedGet(url: string): Promise<Response> {
    const wait = this.spacingMs - (this.now() - this.lastCallAt);
    if (wait > 0) await this.sleep(wait);
    this.lastCallAt = this.now();
    return this.fetchFn(url, { headers: { 'x-cg-demo-api-key': this.apiKey } });
  }

  private async parse(res: Response, cgId: string, date: string): Promise<HistoryResult> {
    if (res.status === 404) return { status: 'unavailable', reason: 'not_found' };

    const body = (await res.json().catch(() => ({}))) as HistoryBody;
    if (res.status === 401) {
      // 10012 = demo/public tier asked for history older than its 365-day window.
      const code = body.error?.status?.error_code ?? body.status?.error_code;
      if (code === 10012) return { status: 'unavailable', reason: 'out_of_range' };
      throw new Error(`CoinGecko 401 (error_code ${code ?? 'unknown'}) — check COINGECKO_API_KEY`);
    }
    if (res.status !== 200) {
      throw new Error(`CoinGecko HTTP ${res.status} for ${cgId} ${date}`);
    }

    const price = body.market_data?.current_price;
    const usd = price?.usd;
    const eur = price?.eur;
    if (usd === undefined || eur === undefined) {
      return { status: 'unavailable', reason: 'no_market_data' };
    }
    return { status: 'ok', usd, eur };
  }
}
