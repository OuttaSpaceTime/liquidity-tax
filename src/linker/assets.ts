import type { Chain } from '../types/event';

/**
 * Canonical asset identity for cross-chain transfer matching.
 *
 * Events store chain-local asset identifiers: symbols on base/sui
 * (handler-resolved), raw mint addresses on solana (Whirlpool handler).
 * Cross-chain amount comparison additionally needs decimals, because amounts
 * are persisted as raw bigints in native units.
 *
 * The registry is deliberately small and explicit — only assets Felix has
 * actually bridged/held need entries. Unknown assets are simply not matched
 * cross-chain (same-chain self-transfer matching compares raw identifiers and
 * raw amounts, so it needs no registry).
 */
export interface CanonicalAsset {
  /** Chain-independent symbol, e.g. 'ETH' for base WETH and solana whWETH. */
  symbol: string;
  /** Decimals of the chain-local representation. */
  decimals: number;
}

/** Keyed by `${chain}:${assetIdAsStoredOnEvents}`. */
const REGISTRY: Readonly<Record<string, CanonicalAsset>> = {
  // --- base (symbols, 1:1 wrappers collapse to the base asset) ---
  'base:ETH': { symbol: 'ETH', decimals: 18 },
  'base:WETH': { symbol: 'ETH', decimals: 18 },
  'base:USDC': { symbol: 'USDC', decimals: 6 },
  'base:USDT': { symbol: 'USDT', decimals: 6 },
  'base:cbBTC': { symbol: 'BTC', decimals: 8 },
  'base:AERO': { symbol: 'AERO', decimals: 18 },
  'base:cbETH': { symbol: 'cbETH', decimals: 18 },

  // --- solana (mint addresses as emitted by the Whirlpool handler) ---
  'solana:So11111111111111111111111111111111111111112': { symbol: 'SOL', decimals: 9 },
  'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', decimals: 6 },
  'solana:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT', decimals: 6 },
  // Wormhole-wrapped WETH (8 decimals on Solana).
  'solana:7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': { symbol: 'ETH', decimals: 8 },
  // Symbol fallbacks in case a future handler resolves mints to symbols.
  'solana:SOL': { symbol: 'SOL', decimals: 9 },
  'solana:USDC': { symbol: 'USDC', decimals: 6 },
  'solana:USDT': { symbol: 'USDT', decimals: 6 },

  // --- sui (symbols, as emitted by the sui handlers) ---
  'sui:SUI': { symbol: 'SUI', decimals: 9 },
  'sui:USDC': { symbol: 'USDC', decimals: 6 },
  'sui:USDT': { symbol: 'USDT', decimals: 6 },
};

/** Canonical identity for a chain-local asset id, or undefined if unmapped. */
export function canonicalAsset(chain: Chain, asset: string): CanonicalAsset | undefined {
  return REGISTRY[`${chain}:${asset}`];
}
