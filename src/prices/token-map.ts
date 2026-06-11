/**
 * Asset symbol → CoinGecko id.
 *
 * Seeded from the production map in
 * liquidity-sheets/tax-report-2025/04-eur-pricing/price_in_eur.py
 * (TOKEN_TO_CG_ID + _CG_ID_TO_CC_TICKER), with two deliberate changes:
 *
 *  - Liquid-staking tokens use their NATIVE CoinGecko ids (volo-staked-sui,
 *    jito-staked-sol, …). The py aliased them to their base asset only because
 *    CryptoCompare had no reliable EUR feeds — CoinGecko has native feeds, and
 *    LSTs are NOT 1:1 (their exchange rate accrues staking yield).
 *  - Exact 1:1 wrappers stay aliased to the base asset (WETH→ethereum,
 *    cbBTC→bitcoin): wrap/unwrap is always 1:1 redeemable, so the base price
 *    IS the wrapper price, and shared ids let the manifest dedupe fetches.
 *
 * cbETH/AAVE/HASUI ids verified via the CoinGecko /search endpoint (2026-06-11).
 */
export const TOKEN_TO_COINGECKO_ID: Readonly<Record<string, string>> = {
  // Majors / chain-native
  SOL: 'solana',
  ETH: 'ethereum',
  WETH: 'ethereum', // 1:1 wrapped ETH
  SUI: 'sui',
  BTC: 'bitcoin',
  cbBTC: 'bitcoin', // 1:1 Coinbase-wrapped BTC
  XRP: 'ripple',
  // Stablecoins
  USDC: 'usd-coin',
  USDT: 'tether',
  // Base / EVM
  AERO: 'aerodrome-finance',
  AAVE: 'aave',
  cbETH: 'coinbase-wrapped-staked-eth', // accruing LST — NOT 1:1 with ETH
  VIRTUAL: 'virtual-protocol',
  // Solana
  ORCA: 'orca',
  JUP: 'jupiter-exchange-solana',
  JLP: 'jupiter-perpetuals-liquidity-provider-token',
  JITOSOL: 'jito-staked-sol',
  PUMP: 'pump-fun',
  AI16Z: 'ai16z',
  CRT: 'carrot',
  // Sui
  CETUS: 'cetus-protocol',
  NAVX: 'navi-protocol',
  DEEP: 'deep',
  WAL: 'walrus-2',
  IKA: 'ika',
  SCA: 'scallop',
  VSUI: 'volo-staked-sui',
  SSUI: 'spring-staked-sui',
  AFSUI: 'aftermath-staked-sui',
  STSUI: 'alphafi-stsui',
  HASUI: 'haedal-staked-sui',
};

const BY_UPPER = new Map(
  Object.entries(TOKEN_TO_COINGECKO_ID).map(([asset, id]) => [asset.toUpperCase(), id]),
);

/** CoinGecko id for an asset symbol (case-insensitive), or undefined if unmapped. */
export function coingeckoIdFor(asset: string): string | undefined {
  return BY_UPPER.get(asset.toUpperCase());
}

/** All asset symbols priced by a CoinGecko id, sorted. Empty if the id is unknown. */
export function assetsForCoingeckoId(cgId: string): string[] {
  return Object.entries(TOKEN_TO_COINGECKO_ID)
    .filter(([, id]) => id === cgId)
    .map(([asset]) => asset)
    .sort();
}
