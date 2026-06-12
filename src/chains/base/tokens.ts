/**
 * Base-chain ERC-20 address → symbol, for the fixture/report asset naming
 * convention (symbols, not addresses — matches the positions/eur-price
 * conventions and `src/prices/token-map.ts`). Shared by all Base handlers;
 * unknown tokens fall back to their lowercase address (which
 * `token-map.ts` can still price via its raw-id section).
 */
export const BASE_TOKEN_SYMBOLS: Readonly<Record<string, string>> = {
  '0x4200000000000000000000000000000000000006': 'WETH',
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 'USDT',
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631': 'AERO',
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 'cbBTC',
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': 'cbETH',
  '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b': 'VIRTUAL',
  '0xbaa5cc21fd487b8fcc2f632f3f4e8d37262a0842': 'MORPHO',
  // symbol() verified on-chain during fixture capture
  '0x532f27101965dd16442e59d40670faf5ebb142e4': 'BRETT',
  '0x11030f79109269d796fd0fb956d6244e502757f7': 'CTR',
};

/** Asset naming convention: symbol for known Base tokens, lowercase address otherwise. */
export function baseTokenSymbol(tokenAddress: string): string {
  return BASE_TOKEN_SYMBOLS[tokenAddress] ?? tokenAddress;
}
