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
  WBTC: 'bitcoin', // 1:1 Wormhole-wrapped BTC (Sui)
  XRP: 'ripple',
  // Stablecoins
  USDC: 'usd-coin',
  wUSDC: 'usd-coin', // 1:1 Wormhole-wrapped USDC (Sui)
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
  CRT: 'carrot-2', // 'carrot' (py-era id) 404s on CoinGecko; 'carrot-2' verified 2026-06-11
  // Sui
  CETUS: 'cetus-protocol',
  NAVX: 'navi', // 'navi-protocol' (py-era id) 404s on CoinGecko; 'navi' verified 2026-06-11
  DEEP: 'deep',
  WAL: 'walrus-2',
  IKA: 'ika',
  SCA: 'scallop',
  VSUI: 'volo-staked-sui',
  SSUI: 'spring-staked-sui',
  AFSUI: 'aftermath-staked-sui',
  STSUI: 'alphafi-stsui',
  HASUI: 'haedal-staked-sui',

  // ---------------------------------------------------------------------------
  // Raw on-chain asset ids. Some handlers emit the raw mint address / ERC-20
  // address / Sui coin type as `asset` when no symbol is resolvable from tx
  // data alone. Each id below was verified against CoinGecko /coins/{id}
  // platform addresses (2026-06-11 backfill integration run).
  // ---------------------------------------------------------------------------
  // Solana mints
  So11111111111111111111111111111111111111112: 'solana', // wSOL (1:1 wrapped)
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'usd-coin', // USDC
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 'jito-staked-sol', // jitoSOL
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: 'orca', // ORCA
  pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn: 'pump-fun', // PUMP
  CRTx1JouZhzSU6XytsE42UQraoGqiHgxabocVfARTy2s: 'carrot-2', // CRT (Carrot)
  HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC: 'ai16z', // AI16Z
  '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4': 'jupiter-perpetuals-liquidity-provider-token', // JLP
  '3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC': 'solstice-eusx', // eUSX
  '6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG': 'usx', // Solstice USX
  // Verified via /coins/solana/contract/{mint} (2026-06-12 integration run)
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'tether', // USDT (legacy Solana mint)
  jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v: 'jupiter-staked-sol', // jupSOL — accruing LST
  '4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs': 'hylo-leveraged-sol', // xSOL (Hylo)
  '5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E': 'hylo-usd', // hyUSD (Hylo)
  '8Jx8AAHj86wbQgUTjGuj6GTTL5Ps3cqxKRTvpaJApump': 'nietzschean-penguin', // PENGUIN (pump.fun)
  // Base ERC-20 addresses (lowercase, as emitted)
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'dai', // DAI
  '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42': 'euro-coin', // EURC
  '0x35e5db674d8e93a03d814fa0ada70731efe8a4b9': 'resolv-usr', // USR (Resolv)
  // Sui coin types
  '0x3a304c7feba2d819ea57c3542d68439ca2c386ba02159c740f7b406e592c62ea::haedal::HAEDAL': 'haedal',
  '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA': 'ika',
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
