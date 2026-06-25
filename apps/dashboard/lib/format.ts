import type { Chain } from '@lt/types/event';
import { canonicalAsset } from '@lt/linker/assets';

/**
 * Token decimals come from the shared `canonicalAsset` registry
 * (src/linker/assets.ts) — the single source of truth, deliberately scoped to
 * assets actually held/bridged. A miss returns undefined so callers render the
 * raw integer with a "raw" marker instead of guessing decimals.
 */
export function assetDecimals(chain: Chain, asset: string): number | undefined {
  return canonicalAsset(chain, asset)?.decimals;
}

/** Display symbol for an asset id (collapses WETH→ETH etc.); falls back to the id. */
export function assetSymbol(chain: Chain, asset: string): string {
  return canonicalAsset(chain, asset)?.symbol ?? asset;
}

/**
 * Format a raw base-unit amount (bigint or decimal string) for display, given
 * decimals. de-DE grouping, sign-aware, trailing zeros trimmed, capped at
 * `maxFrac` fractional digits.
 */
export function formatTokenAmount(
  amount: bigint | string,
  decimals: number,
  maxFrac = 6,
): string {
  const raw = typeof amount === 'bigint' ? amount : BigInt(amount);
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  let fracStr = frac.toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  const wholeStr = whole.toLocaleString('de-DE');
  return `${neg ? '-' : ''}${wholeStr}${fracStr ? ',' + fracStr : ''}`;
}

/** A rendered token amount plus whether decimals were known. */
export interface FormattedAmount {
  text: string;
  /** false ⇒ shown as a raw integer because decimals were unknown. */
  scaled: boolean;
}

export function formatAssetAmount(
  chain: Chain,
  asset: string,
  amount: bigint | string,
  maxFrac = 6,
): FormattedAmount {
  const decimals = assetDecimals(chain, asset);
  if (decimals === undefined) {
    const raw = typeof amount === 'bigint' ? amount : BigInt(amount);
    return { text: raw.toLocaleString('de-DE'), scaled: false };
  }
  return { text: formatTokenAmount(amount, decimals, maxFrac), scaled: true };
}

const EUR = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** EUR in de-DE; null ⇒ em dash (price not cached — never a fabricated 0). */
export function formatEur(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : EUR.format(value);
}
export function formatUsd(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : USD.format(value);
}

/** Unix seconds → 'YYYY-MM-DD HH:mm' UTC. */
export function formatDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
}
export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

const DAY = 86_400;

/** Whole days between two unix-second timestamps (now if `to` omitted). */
export function daysBetween(from: number, to: number): number {
  return Math.floor((to - from) / DAY);
}

/** §23 1-year clock from open (approx — every Tausch restarts it; per-lot = Phase 2). */
export function daysUntilTaxFree(openedAt: number, nowSeconds: number): number {
  return Math.ceil((openedAt + 365 * DAY - nowSeconds) / DAY);
}

/** Tx-hash truncation. PRIVACY: there is deliberately no wallet-address variant. */
export function truncateHash(hash: string): string {
  return hash.length <= 13 ? hash : `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

/** Block-explorer URL for a tx hash, per chain. */
export function explorerTxUrl(chain: Chain, hash: string): string {
  switch (chain) {
    case 'base':
      return `https://basescan.org/tx/${hash}`;
    case 'solana':
      return `https://solscan.io/tx/${hash}`;
    case 'sui':
      return `https://suivision.xyz/txblock/${hash}`;
  }
}
