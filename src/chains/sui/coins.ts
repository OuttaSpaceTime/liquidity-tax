/**
 * Shared Sui coin-type → symbol registry — the ONE place a Sui coin type gets
 * its asset symbol. Used by all Sui handlers (navi, suilend, turbos) so the
 * same on-chain coin never decodes to two different asset strings: symbols
 * are the join key for pricing (src/prices/token-map.ts), the linker's
 * canonical-asset registry (src/linker/assets.ts), and the future FIFO pools.
 *
 * Symbol conventions (aligned with token-map.ts and the golden fixtures):
 *  - Wormhole-wrapped majors collapse to the base symbol where they are
 *    economically the asset: wormhole SOL → SOL, wormhole/native USDT → USDT,
 *    wormhole ETH → WETH (1:1 alias to ethereum in token-map).
 *  - Coins with distinct markets keep distinct symbols (wUSDC vs USDC).
 *  - LSTs keep their native symbols (vSUI, haSUI, sSUI, stSUI — accruing,
 *    never 1:1 with SUI).
 *
 * Sources: the Navi pool-registry snapshot (`onchain/navi-sdk/src/address.ts`
 * ids 0–31 — immutable on-chain constants, deprecation affects tooling only)
 * plus the Suilend-reserve coins verified via suix_getCoinMetadata during
 * fixture capture.
 *
 * Fallback rule (single, shared): unknown coin types resolve to their Move
 * struct name (`…::navx::NAVX` → NAVX), EXCEPT generic wormhole
 * `::coin::COIN` wrappers, which are unidentifiable without a registry entry
 * — those return undefined and the handlers route the tx to the manual queue
 * instead of mislabeling every wrapped asset as 'COIN'.
 */

/** Coin type (short-form 0x addresses ok — normalized before lookup) → symbol. */
export const SUI_COIN_REGISTRY: Readonly<Record<string, string>> = {
  '0x2::sui::SUI': 'SUI',
  // Wormhole-wrapped (generic ::coin::COIN — only resolvable via this registry)
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN': 'wUSDC',
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN': 'USDT',
  '0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN': 'WETH',
  '0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN': 'WBTC',
  '0xb7844e289a8410e50fb3ca48d69eb9cf29e27d223ef90353fe1bd8e27ff8f3f8::coin::COIN': 'SOL',
  '0x5f496ed5d9d045c5b788dc1bb85f54100f2ede11e46f6a232c29daada4c5bdb6::coin::COIN': 'stBTC',
  '0x8f2b5eb696ed88b71fea398d330bccfa52f6e2a5a8e1ac6180fcb25c6de42ebc::coin::COIN': 'enzoBTC',
  // Native / named coins
  '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS': 'CETUS',
  '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT': 'vSUI',
  '0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI': 'haSUI',
  '0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI':
    'sSUI',
  '0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX': 'NAVX',
  '0x2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2::ausd::AUSD': 'AUSD',
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC': 'USDC',
  '0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH': 'ETH',
  '0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb::usdy::USDY': 'USDY',
  '0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS': 'NS',
  '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP': 'DEEP',
  '0xf16e6b723f242ec745dfd7634ad072c42d5c1d9ac9d62a39c381303eaa57693a::fdusd::FDUSD': 'FDUSD',
  '0xe1b45a0e641b9955a20aa0ad1c1f4ad86aad8afb07296d4085e349a50e90bdca::blue::BLUE': 'BLUE',
  '0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2::buck::BUCK': 'BUCK',
  '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT': 'USDT',
  '0xd1b72982e40348d069bb1ff701e634c117bb5f741f44dff91e472d3b01461e55::stsui::STSUI': 'stSUI',
  '0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b::btc::BTC': 'suiBTC',
  '0x3e8e9423d80e1774a7ca128fccd8bf5f1f7753be658c5e645929037f7c819040::lbtc::LBTC': 'LBTC',
  '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL': 'WAL',
  '0x3a304c7feba2d819ea57c3542d68439ca2c386ba02159c740f7b406e592c62ea::haedal::HAEDAL': 'HAEDAL',
  '0x876a4b7bce8aeaef60464c11f4026903e9afacab79b9b142686158aa86560b50::xbtc::XBTC': 'XBTC',
  '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA': 'IKA',
  '0xd1a91b46bd6d966b62686263609074ad16cfdffc63c31a4775870a2d54d20c6b::mbtc::MBTC': 'MBTC',
  '0xa03ab7eee2c8e97111977b77374eaf6324ba617e7027382228350db08469189e::ybtc::YBTC': 'YBTC',
  '0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM': 'XAUM',
};

/**
 * Normalize a Sui coin type for map lookup: strip the optional `0x`,
 * lowercase, left-pad the address to 64 hex chars (parsedJson `TypeName.name`
 * strings come without `0x` but fully padded; SDK constants use the short
 * form).
 */
export function normalizeCoinType(coinType: string): string {
  const [address, ...rest] = coinType.split('::');
  const hex = (address ?? '').replace(/^0x/i, '').toLowerCase().padStart(64, '0');
  return [hex, ...rest].join('::');
}

const SYMBOL_BY_NORMALIZED_TYPE: ReadonlyMap<string, string> = new Map(
  Object.entries(SUI_COIN_REGISTRY).map(([coinType, symbol]) => [
    normalizeCoinType(coinType),
    symbol,
  ]),
);

/**
 * Symbol for a coin-type string (with or without `0x`). Unknown types fall
 * back to the Move struct name — except generic wormhole `::coin::COIN`
 * wrappers, which are unidentifiable without a registry entry (undefined →
 * the handler routes the tx to the manual queue).
 */
export function suiCoinSymbol(coinType: string): string | undefined {
  const known = SYMBOL_BY_NORMALIZED_TYPE.get(normalizeCoinType(coinType));
  if (known !== undefined) return known;
  const structName = coinType.split('::')[2];
  return structName === undefined || structName === 'COIN' ? undefined : structName;
}
