import type { DecodeContext, DecodeResult, Handler, RawTx } from '../decoder/types';
import type { Flag, TaxEvent } from '../types/event';
import {
  HAEDAL_EVENT_TYPES,
  NAVI_EVENT_TYPES,
  NAVI_EVENT_TYPE_SUFFIXES,
  type HaedalUserInstantUnstaked,
  type HaedalUserNormalUnstaked,
  type HaedalUserStaked,
  type NaviBorrowEvent,
  type NaviDepositEvent,
  type NaviFlashLoan,
  type NaviLiquidationEvent,
  type NaviPoolDeposit,
  type NaviPoolWithdraw,
  type NaviRepayEvent,
  type NaviRewardClaimedV3,
  type NaviRewardsClaimedV2,
  type NaviWithdrawEvent,
} from '../types/navi-events';

/**
 * [1C.4] Navi (lending) phase-1 handler + LST loop detector.
 *
 * Decodes the Move events discovered by the U0 spike
 * (`src/types/navi-events.ts`, `docs/sui-event-discovery.md` §Navi) straight
 * from `raw_txs.raw_json.events` — no SDK in the decode path (the deprecated
 * `navi-sdk` does not block historical decoding; events are immutable
 * on-chain data). Event mapping, asset-symbol naming, `logIndex` (= index in
 * the tx's `events` array), flags, and the liquidation emission order are
 * pinned by the [1C.6] golden fixtures (`tests/fixtures/sui/navi-*.json`).
 *
 * Asset resolution (lending events carry only `reserve: u8`):
 *  1. Pair with the same-tx `pool::PoolDeposit`/`PoolWithdraw` companion
 *     (nearest preceding unconsumed leg with the exact same amount) — its
 *     `pool` field is the coin-type string, the dynamic truth from the tx.
 *  2. Fall back to the static assetId registry below (liquidations have no
 *     amount-matching companion: `collateral_amount` includes the treasury
 *     cut that never reaches the liquidator's PoolWithdraw).
 *
 * Loop detector (doc 05 / discovery doc question (b)): within ONE PTB digest,
 * an LST mint (SUI → haSUI/vSUI swap) + a Navi deposit of that LST + a Navi
 * borrow of SUI ⇒ the leveraged loop; all constituent events are flagged
 * `looping_pattern` (order-agnostic — the own-history variant front-runs the
 * deposit with a flash-loan-funded stake). The unwind direction (LST burn +
 * SUI repay [+ LST withdraw]) is flagged the same way. Tax treatment of
 * flagged events: docs/tax-policy.md (locked: re-staking borrowed SUI is NOT
 * a disposal — the decoder still records the swap; the report engine applies
 * the policy).
 */

const HANDLER_ID = 'navi';
const HANDLER_VERSION = 1;

// ---------------------------------------------------------------------------
// Volo (vSUI) native staking — the LST leg actually present in own history
// (navi-01 fixture: flash-loan leverage loop with vSUI instead of haSUI).
// Defining ID = the CERT coin package; payload confirmed by the fixture.
// ---------------------------------------------------------------------------

const VOLO_PACKAGE = '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55';
const VOLO_STAKED_EVENT = `${VOLO_PACKAGE}::native_pool::StakedEvent`;
/**
 * Volo unstake — never observed in own history or live sampling; the payload
 * shape is unverified, so any occurrence routes to the manual queue instead
 * of being decoded on a guess.
 */
const VOLO_UNSTAKED_SUFFIX = '::native_pool::UnstakedEvent';

/** SUI staked → vSUI (CERT) minted. {staker, sui_amount, cert_amount}. */
interface VoloStakedEvent {
  staker: string;
  sui_amount: string;
  cert_amount: string;
}

/**
 * LiquidationEvent defining ID, pinned by the navi-02 golden fixture
 * (the U0 spike could not confirm it — see NAVI_EVENT_TYPE_SUFFIXES).
 * Matching stays suffix-based to survive future package upgrades.
 */
export const NAVI_PACKAGE_LIQUIDATION_DEFINING =
  '0xc6374c7da60746002bfee93014aeb607e023b2d6b25c9e55a152b826dbc8c1ce';

// ---------------------------------------------------------------------------
// Navi assetId registry. Asset ids are immutable once assigned; table copied
// from the on-chain pool registry snapshot in
// `onchain/navi-sdk/src/address.ts` (ids 0–31; the deprecation only affects
// tooling, not these constants) and cross-checked live by the fixtures
// (navi-01 pins 0=SUI and 5=vSUI, navi-02 pins 2=USDT and 6=haSUI).
// Symbols follow the project convention (src/prices/token-map.ts / fixture
// labels): vSUI, haSUI, USDT (wormhole), USDC = native, wUSDC = wormhole.
// New listings (id > 31) resolve via the pool-event pairing; if that also
// fails the tx goes to the manual queue rather than mislabeling.
// ---------------------------------------------------------------------------

interface NaviAsset {
  id: number;
  symbol: string;
  /** Canonical coin type (short-form address ok — normalized before lookup). */
  coinType: string;
}

const NAVI_ASSETS: readonly NaviAsset[] = [
  { id: 0, symbol: 'SUI', coinType: '0x2::sui::SUI' },
  {
    id: 1,
    symbol: 'wUSDC',
    coinType: '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN',
  },
  {
    id: 2,
    symbol: 'USDT',
    coinType: '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN',
  },
  {
    id: 3,
    symbol: 'WETH',
    coinType: '0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN',
  },
  {
    id: 4,
    symbol: 'CETUS',
    coinType: '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS',
  },
  {
    id: 5,
    symbol: 'vSUI',
    coinType: '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT',
  },
  {
    id: 6,
    symbol: 'haSUI',
    coinType: '0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI',
  },
  {
    id: 7,
    symbol: 'NAVX',
    coinType: '0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX',
  },
  {
    id: 8,
    symbol: 'WBTC',
    coinType: '0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN',
  },
  {
    id: 9,
    symbol: 'AUSD',
    coinType: '0x2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2::ausd::AUSD',
  },
  {
    id: 10,
    symbol: 'USDC',
    coinType: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  },
  {
    id: 11,
    symbol: 'ETH',
    coinType: '0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH',
  },
  {
    id: 12,
    symbol: 'USDY',
    coinType: '0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb::usdy::USDY',
  },
  {
    id: 13,
    symbol: 'NS',
    coinType: '0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS',
  },
  {
    id: 14,
    symbol: 'stBTC',
    coinType: '0x5f496ed5d9d045c5b788dc1bb85f54100f2ede11e46f6a232c29daada4c5bdb6::coin::COIN',
  },
  {
    id: 15,
    symbol: 'DEEP',
    coinType: '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP',
  },
  {
    id: 16,
    symbol: 'FDUSD',
    coinType: '0xf16e6b723f242ec745dfd7634ad072c42d5c1d9ac9d62a39c381303eaa57693a::fdusd::FDUSD',
  },
  {
    id: 17,
    symbol: 'BLUE',
    coinType: '0xe1b45a0e641b9955a20aa0ad1c1f4ad86aad8afb07296d4085e349a50e90bdca::blue::BLUE',
  },
  {
    id: 18,
    symbol: 'BUCK',
    coinType: '0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2::buck::BUCK',
  },
  {
    id: 19,
    symbol: 'suiUSDT',
    coinType: '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT',
  },
  {
    id: 20,
    symbol: 'stSUI',
    coinType: '0xd1b72982e40348d069bb1ff701e634c117bb5f741f44dff91e472d3b01461e55::stsui::STSUI',
  },
  {
    id: 21,
    symbol: 'suiBTC',
    coinType: '0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b::btc::BTC',
  },
  {
    id: 22,
    symbol: 'WSOL',
    coinType: '0xb7844e289a8410e50fb3ca48d69eb9cf29e27d223ef90353fe1bd8e27ff8f3f8::coin::COIN',
  },
  {
    id: 23,
    symbol: 'LBTC',
    coinType: '0x3e8e9423d80e1774a7ca128fccd8bf5f1f7753be658c5e645929037f7c819040::lbtc::LBTC',
  },
  {
    id: 24,
    symbol: 'WAL',
    coinType: '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL',
  },
  {
    id: 25,
    symbol: 'HAEDAL',
    coinType: '0x3a304c7feba2d819ea57c3542d68439ca2c386ba02159c740f7b406e592c62ea::haedal::HAEDAL',
  },
  {
    id: 26,
    symbol: 'XBTC',
    coinType: '0x876a4b7bce8aeaef60464c11f4026903e9afacab79b9b142686158aa86560b50::xbtc::XBTC',
  },
  {
    id: 27,
    symbol: 'IKA',
    coinType: '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA',
  },
  {
    id: 28,
    symbol: 'enzoBTC',
    coinType: '0x8f2b5eb696ed88b71fea398d330bccfa52f6e2a5a8e1ac6180fcb25c6de42ebc::coin::COIN',
  },
  {
    id: 29,
    symbol: 'MBTC',
    coinType: '0xd1a91b46bd6d966b62686263609074ad16cfdffc63c31a4775870a2d54d20c6b::mbtc::MBTC',
  },
  {
    id: 30,
    symbol: 'YBTC',
    coinType: '0xa03ab7eee2c8e97111977b77374eaf6324ba617e7027382228350db08469189e::ybtc::YBTC',
  },
  {
    id: 31,
    symbol: 'XAUM',
    coinType: '0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM',
  },
];

/**
 * Normalize a Sui coin type for map lookup: strip the optional `0x`,
 * lowercase, left-pad the address to 64 hex chars (parsedJson strings come
 * without `0x` but fully padded; SDK constants use the short form).
 */
function normalizeCoinType(coinType: string): string {
  const [address, ...rest] = coinType.split('::');
  const hex = (address ?? '').replace(/^0x/i, '').toLowerCase().padStart(64, '0');
  return [hex, ...rest].join('::');
}

const SYMBOL_BY_ASSET_ID = new Map(NAVI_ASSETS.map((a) => [a.id, a.symbol]));
const ASSET_BY_ID = new Map(NAVI_ASSETS.map((a) => [a.id, a]));
const SYMBOL_BY_COIN_TYPE = new Map(
  NAVI_ASSETS.map((a) => [normalizeCoinType(a.coinType), a.symbol]),
);

/**
 * Symbol for a coin-type string from parsedJson. Unknown types fall back to
 * the Move struct name (`…::navx::NAVX` → NAVX) — except generic wormhole
 * `::coin::COIN` wrappers, which are unidentifiable without the registry.
 */
function symbolForCoinType(coinType: string): string | undefined {
  const known = SYMBOL_BY_COIN_TYPE.get(normalizeCoinType(coinType));
  if (known !== undefined) return known;
  const structName = coinType.split('::')[2];
  return structName === undefined || structName === 'COIN' ? undefined : structName;
}

// ---------------------------------------------------------------------------
// Raw-tx event access
// ---------------------------------------------------------------------------

interface SuiEventShape {
  type?: string;
  parsedJson?: unknown;
}

function suiEvents(rawJson: unknown): readonly SuiEventShape[] {
  const events = (rawJson as { events?: unknown }).events;
  return Array.isArray(events) ? (events as SuiEventShape[]) : [];
}

/**
 * Types this handler reacts to. Confirmed events match exactly on their
 * defining ID (immutable per Sui type-identity semantics); events first
 * defined in unsampled upgrades match by `::module::Name` suffix
 * (discovery-doc follow-up 4).
 */
const MATCH_EXACT = new Set<string>([
  ...Object.values(NAVI_EVENT_TYPES),
  ...Object.values(HAEDAL_EVENT_TYPES),
  VOLO_STAKED_EVENT,
]);

const MATCH_SUFFIXES: readonly string[] = [
  ...Object.values(NAVI_EVENT_TYPE_SUFFIXES),
  VOLO_UNSTAKED_SUFFIX,
];

function isHandledType(type: string): boolean {
  return MATCH_EXACT.has(type) || MATCH_SUFFIXES.some((suffix) => type.endsWith(suffix));
}

// ---------------------------------------------------------------------------
// Pool-event companions: lending::* events carry only the asset index; the
// adjacent pool::PoolDeposit/PoolWithdraw carries the coin-type string.
// ---------------------------------------------------------------------------

interface PoolLeg {
  index: number;
  coinType: string;
  amount: string;
  consumed: boolean;
}

/** Nearest preceding unconsumed leg with the exact amount; consumes it. */
function pairPoolLeg(legs: PoolLeg[], beforeIndex: number, amount: string): string | undefined {
  for (let i = legs.length - 1; i >= 0; i--) {
    const leg = legs[i];
    if (!leg.consumed && leg.index < beforeIndex && leg.amount === amount) {
      leg.consumed = true;
      return leg.coinType;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Post-decode flag passes (tx-local; the cross-handler variant would live in
// a phase-3 aggregation hook, but every constituent event is ours)
// ---------------------------------------------------------------------------

const LST_SYMBOLS = new Set(['haSUI', 'vSUI']);

function addFlag(event: TaxEvent, flag: Flag): void {
  if (event.flags === undefined) event.flags = [flag];
  else if (!event.flags.includes(flag)) event.flags.push(flag);
}

/**
 * LST leverage-loop detection (doc 05 / discovery doc question (b)),
 * order-agnostic within the digest:
 *  - wind up:  LST mint (SUI→LST swap) + Navi deposit of that LST + SUI borrow
 *  - unwind:   LST burn (LST→SUI swap) + SUI repay (+ LST withdraw if present)
 */
function applyLoopFlags(events: TaxEvent[]): void {
  const mints = events.filter(
    (e) => e.type === 'swap' && e.sentAsset === 'SUI' && LST_SYMBOLS.has(e.receivedAsset ?? ''),
  );
  const burns = events.filter(
    (e) => e.type === 'swap' && e.receivedAsset === 'SUI' && LST_SYMBOLS.has(e.sentAsset ?? ''),
  );

  const mintedLsts = new Set(mints.map((e) => e.receivedAsset ?? ''));
  const lstDeposits = events.filter(
    (e) => e.type === 'lend_supply' && e.subtype === 'deposit' && mintedLsts.has(e.sentAsset ?? ''),
  );
  const suiBorrows = events.filter(
    (e) => e.type === 'lend_borrow' && e.subtype === 'borrow' && e.receivedAsset === 'SUI',
  );
  if (mints.length > 0 && lstDeposits.length > 0 && suiBorrows.length > 0) {
    for (const event of [...mints, ...lstDeposits, ...suiBorrows]) {
      addFlag(event, 'looping_pattern');
    }
  }

  const burnedLsts = new Set(burns.map((e) => e.sentAsset ?? ''));
  const lstWithdraws = events.filter(
    (e) =>
      e.type === 'lend_supply' && e.subtype === 'withdraw' && burnedLsts.has(e.receivedAsset ?? ''),
  );
  const suiRepays = events.filter(
    (e) => e.type === 'lend_borrow' && e.subtype === 'repay' && e.sentAsset === 'SUI',
  );
  if (burns.length > 0 && suiRepays.length > 0) {
    for (const event of [...burns, ...suiRepays, ...lstWithdraws]) {
      addFlag(event, 'looping_pattern');
    }
  }
}

/** A deposit re-supplying exactly what a same-tx reward claim paid out. */
function applyAutoCompoundFlags(events: TaxEvent[]): void {
  const claims = events.filter((e) => e.type === 'lend_reward');
  for (const deposit of events) {
    if (deposit.type !== 'lend_supply' || deposit.subtype !== 'deposit') continue;
    const compounded = claims.some(
      (claim) =>
        claim.logIndex < deposit.logIndex &&
        claim.receivedAsset === deposit.sentAsset &&
        claim.receivedAmount === deposit.sentAmount,
    );
    if (compounded) addFlag(deposit, 'auto_compounded');
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const naviHandler: Handler = {
  id: HANDLER_ID,
  version: HANDLER_VERSION,
  chain: 'sui',

  /** Cheap check: any Navi / Haedal / Volo event type in the tx's event list. */
  matches(raw: RawTx): boolean {
    if (raw.chain !== 'sui') return false;
    return suiEvents(raw.rawJson).some((event) => isHandledType(event.type ?? ''));
  },

  decode(raw: RawTx, ctx: DecodeContext): DecodeResult {
    const events = suiEvents(raw.rawJson);
    const out: TaxEvent[] = [];
    const problems: string[] = [];
    let ownedFlashLoan = false;

    // Index the pool fund-flow companions first (they precede their lending event).
    const poolDeposits: PoolLeg[] = [];
    const poolWithdraws: PoolLeg[] = [];
    events.forEach((event, index) => {
      if (event.type === NAVI_EVENT_TYPES.poolDeposit) {
        const p = event.parsedJson as NaviPoolDeposit;
        poolDeposits.push({ index, coinType: p.pool, amount: p.amount, consumed: false });
      } else if (event.type === NAVI_EVENT_TYPES.poolWithdraw) {
        const p = event.parsedJson as NaviPoolWithdraw;
        poolWithdraws.push({ index, coinType: p.pool, amount: p.amount, consumed: false });
      }
    });

    const reserveSymbol = (
      reserve: number,
      eventIndex: number,
      amount: string,
      legs: PoolLeg[],
    ): string | undefined => {
      const coinType = pairPoolLeg(legs, eventIndex, amount);
      // Pool-leg pairing matches on exact amount only — two same-raw-amount
      // legs of DIFFERENT coins can hand us the wrong leg. When the static
      // registry knows the reserve, the paired coin type must agree with it;
      // a contradiction means the pairing picked a colliding leg → manual
      // queue instead of a silent asset mislabel.
      const registryAsset = ASSET_BY_ID.get(reserve);
      if (
        coinType !== undefined &&
        registryAsset !== undefined &&
        normalizeCoinType(coinType) !== normalizeCoinType(registryAsset.coinType)
      ) {
        problems.push(
          `event[${eventIndex}]: paired pool leg coin '${coinType}' contradicts reserve ${reserve} ` +
            `(${registryAsset.symbol}) — same-amount pairing collision, label manually`,
        );
        return undefined;
      }
      const paired = coinType === undefined ? undefined : symbolForCoinType(coinType);
      return paired ?? SYMBOL_BY_ASSET_ID.get(reserve);
    };

    const base = {
      chain: 'sui' as const,
      txHash: raw.txHash,
      timestamp: raw.blockTimestamp,
      emissionSeq: 0,
      handlerId: HANDLER_ID,
      handlerVersion: HANDLER_VERSION,
    };

    for (const [index, event] of events.entries()) {
      const type = event.type ?? '';
      const payload = event.parsedJson;

      if (type === NAVI_EVENT_TYPES.deposit) {
        const p = payload as NaviDepositEvent;
        if (!ctx.wallets.has(p.sender)) continue;
        const symbol = reserveSymbol(p.reserve, index, p.amount, poolDeposits);
        if (symbol === undefined) {
          problems.push(`DepositEvent[${index}]: unresolvable reserve ${p.reserve}`);
          continue;
        }
        out.push({
          ...base,
          type: 'lend_supply',
          subtype: 'deposit',
          logIndex: index,
          wallet: p.sender,
          sentAsset: symbol,
          sentAmount: BigInt(p.amount),
        });
      } else if (type === NAVI_EVENT_TYPES.withdraw) {
        const p = payload as NaviWithdrawEvent;
        const wallet = ctx.wallets.has(p.sender)
          ? p.sender
          : ctx.wallets.has(p.to)
            ? p.to
            : undefined;
        if (wallet === undefined) continue;
        const symbol = reserveSymbol(p.reserve, index, p.amount, poolWithdraws);
        if (symbol === undefined) {
          problems.push(`WithdrawEvent[${index}]: unresolvable reserve ${p.reserve}`);
          continue;
        }
        out.push({
          ...base,
          type: 'lend_supply',
          subtype: 'withdraw',
          logIndex: index,
          wallet,
          receivedAsset: symbol,
          receivedAmount: BigInt(p.amount),
        });
      } else if (type === NAVI_EVENT_TYPES.borrow) {
        const p = payload as NaviBorrowEvent;
        if (!ctx.wallets.has(p.sender)) continue;
        const symbol = reserveSymbol(p.reserve, index, p.amount, poolWithdraws);
        if (symbol === undefined) {
          problems.push(`BorrowEvent[${index}]: unresolvable reserve ${p.reserve}`);
          continue;
        }
        // Borrow is NOT income — liability in, asset in (docs/tax-policy.md).
        out.push({
          ...base,
          type: 'lend_borrow',
          subtype: 'borrow',
          logIndex: index,
          wallet: p.sender,
          receivedAsset: symbol,
          receivedAmount: BigInt(p.amount),
        });
      } else if (type === NAVI_EVENT_TYPES.repay) {
        const p = payload as NaviRepayEvent;
        if (!ctx.wallets.has(p.sender)) continue;
        const symbol = reserveSymbol(p.reserve, index, p.amount, poolDeposits);
        if (symbol === undefined) {
          problems.push(`RepayEvent[${index}]: unresolvable reserve ${p.reserve}`);
          continue;
        }
        out.push({
          ...base,
          type: 'lend_borrow',
          subtype: 'repay',
          logIndex: index,
          wallet: p.sender,
          sentAsset: symbol,
          sentAmount: BigInt(p.amount),
        });
      } else if (type.endsWith(NAVI_EVENT_TYPE_SUFFIXES.liquidation)) {
        const p = payload as NaviLiquidationEvent;
        if (ctx.wallets.has(p.user)) {
          // Decoded from the liquidated user's perspective. The seized total
          // includes the treasury cut (it left the user's position either way).
          const collateral = SYMBOL_BY_ASSET_ID.get(p.collateral_asset);
          const debt = SYMBOL_BY_ASSET_ID.get(p.debt_asset);
          if (collateral === undefined || debt === undefined) {
            problems.push(
              `LiquidationEvent[${index}]: unresolvable asset ids ${p.collateral_asset}/${p.debt_asset}`,
            );
            continue;
          }
          out.push({
            ...base,
            type: 'liquidation',
            subtype: 'collateral_seized',
            logIndex: index,
            emissionSeq: 0,
            wallet: p.user,
            sentAsset: collateral,
            sentAmount: BigInt(p.collateral_amount),
          });
          out.push({
            ...base,
            type: 'liquidation',
            subtype: 'debt_repaid',
            logIndex: index,
            emissionSeq: 1,
            wallet: p.user,
            receivedAsset: debt,
            receivedAmount: BigInt(p.debt_amount),
          });
        } else if (ctx.wallets.has(p.sender)) {
          problems.push(
            `LiquidationEvent[${index}]: owned wallet is the liquidator — liquidator-side decoding not implemented`,
          );
        }
      } else if (type === NAVI_EVENT_TYPES.rewardClaimedV3) {
        const p = payload as NaviRewardClaimedV3;
        if (!ctx.wallets.has(p.user)) continue;
        const symbol = symbolForCoinType(p.coin_type);
        if (symbol === undefined) {
          problems.push(`RewardClaimed[${index}]: unresolvable coin type`);
          continue;
        }
        out.push({
          ...base,
          type: 'lend_reward',
          subtype: 'claim',
          logIndex: index,
          wallet: p.user,
          receivedAsset: symbol,
          receivedAmount: BigInt(p.total_claimed),
        });
      } else if (type === NAVI_EVENT_TYPES.rewardsClaimedV2) {
        const p = payload as NaviRewardsClaimedV2;
        if (!ctx.wallets.has(p.sender)) continue;
        // Legacy claim carries only the funds-pool object id, no coin type —
        // needs the v2 funds-pool registry; route to the manual queue.
        problems.push(
          `incentive_v2 RewardsClaimed[${index}]: no coin type in event (funds-pool registry not implemented)`,
        );
      } else if (type === NAVI_EVENT_TYPES.flashLoan) {
        const p = payload as NaviFlashLoan;
        // Borrowed and repaid inside the same PTB: never a taxable borrow.
        // Flag-only per doc 05; the FlashRepay fee stays embedded in the
        // repay PoolDeposit amount (visible in raw_json if ever needed).
        if (ctx.wallets.has(p.sender)) ownedFlashLoan = true;
      } else if (type === HAEDAL_EVENT_TYPES.userStaked) {
        const p = payload as HaedalUserStaked;
        if (!ctx.wallets.has(p.owner)) continue;
        out.push({
          ...base,
          type: 'swap',
          subtype: 'trade',
          logIndex: index,
          wallet: p.owner,
          sentAsset: 'SUI',
          sentAmount: BigInt(p.sui_amount),
          receivedAsset: 'haSUI',
          receivedAmount: BigInt(p.st_amount),
        });
      } else if (
        type === HAEDAL_EVENT_TYPES.userInstantUnstaked ||
        type === HAEDAL_EVENT_TYPES.userNormalUnstaked
      ) {
        const p = payload as HaedalUserInstantUnstaked | HaedalUserNormalUnstaked;
        if (!ctx.wallets.has(p.owner)) continue;
        // Delayed (normal) unstake: the haSUI disposal is recognized here, at
        // the unstake event where both amounts are fixed; the later UserClaimed
        // payout emits nothing (docs/tax-policy.md §haSUI loop).
        out.push({
          ...base,
          type: 'swap',
          subtype: 'trade',
          logIndex: index,
          wallet: p.owner,
          sentAsset: 'haSUI',
          sentAmount: BigInt(p.st_amount),
          receivedAsset: 'SUI',
          receivedAmount: BigInt(p.sui_amount),
        });
      } else if (type === HAEDAL_EVENT_TYPES.userClaimed) {
        // SUI payout of a matured unstake ticket — already recognized at the
        // UserNormalUnstaked swap above. No event.
      } else if (type === VOLO_STAKED_EVENT) {
        const p = payload as VoloStakedEvent;
        if (!ctx.wallets.has(p.staker)) continue;
        out.push({
          ...base,
          type: 'swap',
          subtype: 'trade',
          logIndex: index,
          wallet: p.staker,
          sentAsset: 'SUI',
          sentAmount: BigInt(p.sui_amount),
          receivedAsset: 'vSUI',
          receivedAmount: BigInt(p.cert_amount),
        });
      } else if (type.endsWith(VOLO_UNSTAKED_SUFFIX)) {
        problems.push(`Volo unstake[${index}]: payload shape unverified — label manually`);
      } else if (
        type.endsWith(NAVI_EVENT_TYPE_SUFFIXES.depositOnBehalfOf) ||
        type.endsWith(NAVI_EVENT_TYPE_SUFFIXES.repayOnBehalfOf)
      ) {
        const p = payload as { sender: string; user: string };
        if (ctx.wallets.has(p.sender) || ctx.wallets.has(p.user)) {
          problems.push(`${type.split('::').pop()}[${index}]: on-behalf-of flow — label manually`);
        }
      }
      // Everything else (pool companions, logic::StateUpdated, oracle updates,
      // other protocols' events sharing the PTB) emits nothing here.
    }

    // Owned PTB containing a swap-shaped event no handler recognizes (e.g. a
    // Cetus pool::SwapEvent disposing the withdrawn collateral, navi-04):
    // returning kind:'ok' would mark the tx 'decoded' and silently drop a
    // §23-relevant disposal. Until a Cetus/generic Sui swap rule lands, such
    // txs go to the manual queue. (Conservative: an aggregator summary that a
    // LATER handler would claim also trips this — manual review, never loss.)
    const sender = (raw.rawJson as { transaction?: { data?: { sender?: string } } }).transaction
      ?.data?.sender;
    if (sender !== undefined && ctx.wallets.has(sender)) {
      for (const [index, event] of events.entries()) {
        const type = event.type ?? '';
        if (type === '' || isHandledType(type)) continue;
        const structName = type.split('<')[0]!.split('::').pop() ?? '';
        if (/swap/i.test(structName)) {
          problems.push(
            `unrecognized swap leg '${type.split('<')[0]}' at event index ${index} in an owned ` +
              'PTB — foreign-protocol disposal, label manually (no Cetus/generic Sui swap handler yet)',
          );
        }
      }
    }

    // Partial decodes must not silently understate taxable activity.
    if (problems.length > 0) return { kind: 'unclassified', reason: problems.join('; ') };
    // Navi/LST machinery in the tx, but none of it concerns an owned wallet.
    if (out.length === 0) return { kind: 'skip' };

    applyLoopFlags(out);
    applyAutoCompoundFlags(out);
    if (ownedFlashLoan) for (const event of out) addFlag(event, 'flash_loan');

    return { kind: 'ok', events: out };
  },
};
