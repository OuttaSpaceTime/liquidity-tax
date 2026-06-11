import { closeInstantOf } from './dates';

/**
 * DefiLlama coins API (keyless) — USD-only fallback for pairs CoinGecko can't
 * serve (long-tail tokens, demo-tier 365-day window).
 *
 * Endpoint + confidence filter mirrored from rotki
 * (rotkehlchen/externalapis/defillama.py): `prices/historical/{ts}/{coin}`
 * with `coingecko:{id}` coin keys; prices with confidence < 0.2 are discarded
 * as probable spam.
 */

const MIN_CONFIDENCE = 0.2;

export interface DefiLlamaClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Minimum spacing between calls; default 250ms (well under the public limit). */
  spacingMs?: number;
}

interface HistoricalBody {
  coins?: Record<string, { price?: number; confidence?: number }>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DefiLlamaClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly spacingMs: number;
  private lastCallAt = Number.NEGATIVE_INFINITY;

  constructor(opts: DefiLlamaClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? 'https://coins.llama.fi';
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
    this.spacingMs = opts.spacingMs ?? 250;
  }

  /**
   * USD daily close (00:00 UTC of date+1) for a CoinGecko-identified coin.
   * Returns null when DefiLlama has no (confident) price — callers record the
   * pair as failed rather than guessing.
   */
  async fetchUsdClose(cgId: string, date: string): Promise<number | null> {
    // CoinGecko ids are [a-z0-9-] (URL-safe), and DefiLlama keys its response
    // by the raw `coingecko:{id}` string — so the coin goes into the path raw.
    const coin = `coingecko:${cgId}`;
    const url = `${this.baseUrl}/prices/historical/${closeInstantOf(date)}/${coin}?searchWidth=4h`;

    const wait = this.spacingMs - (this.now() - this.lastCallAt);
    if (wait > 0) await this.sleep(wait);
    this.lastCallAt = this.now();

    const res = await this.fetchFn(url);
    if (res.status !== 200) return null;
    const body = (await res.json().catch(() => ({}))) as HistoricalBody;
    const entry = body.coins?.[coin];
    if (entry?.price === undefined) return null;
    if (entry.confidence !== undefined && entry.confidence < MIN_CONFIDENCE) return null;
    return entry.price;
  }
}
