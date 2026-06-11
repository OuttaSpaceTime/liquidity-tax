/**
 * Price-convention date helpers.
 *
 * Uniform daily-price convention (BMF Rz 91 — Tageskurse must be applied
 * uniformly to acquisitions AND disposals, see planning doc 07 §3):
 * the price of UTC calendar day D is the DAILY CLOSE, i.e. the value observed
 * at 00:00:00 UTC of D+1. All sources are read at that same instant:
 *   - CoinGecko `/coins/{id}/history?date=D+1` (snapshot at 00:00 UTC),
 *   - the liquidity-sheets EUR cache (last hourly close, timestamped 00:00 UTC of D+1),
 *   - DefiLlama `prices/historical/{ts}` with ts = 00:00 UTC of D+1.
 */

/** UTC calendar day (YYYY-MM-DD) of a unix-seconds timestamp. */
export function utcDateOf(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** Unix seconds of 00:00:00 UTC on the day AFTER `date` — the daily-close instant. */
export function closeInstantOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d + 1) / 1000;
}

/** CoinGecko `/history` date param (DD-MM-YYYY) for the daily close of `date`. */
export function coingeckoHistoryDateOf(date: string): string {
  const next = new Date(closeInstantOf(date) * 1000);
  const dd = String(next.getUTCDate()).padStart(2, '0');
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${next.getUTCFullYear()}`;
}
