# naviprotocol-monorepo (NEW canonical Navi SDK)

**Location:** `/home/felix/Code/Misc/defi-tracker/onchain/naviprotocol-monorepo/`
**Language:** TypeScript
**License:** MIT
**Maintenance:** Latest commit 3fc250b (2026-04-18, `Merge pull request #69 from naviprotocol/feat/optimize`). Actively maintained; version 1.4.3 released.

## What Supersedes What

The monorepo is the **canonical modern Navi SDK**, replacing `navi-sdk` (v1.6.23, deprecated):

| Aspect | Old navi-sdk | New monorepo |
|---|---|---|
| Package name (npm) | `navi-sdk` | `@naviprotocol/lending` (+ astros-aggregator, -bridge, wallet-client) |
| Package location | `/src/` flat | `/packages/lending/src/` monorepo structure |
| Entry point | `src/naviSDK.ts` (NAVISDKClient class) | `/packages/lending/src/index.ts` (function-based API) |
| Address/config | `address.ts` (static exports) | `config.ts` (dynamic API fetch from `https://open-api.naviprotocol.io`) |
| Reward history | `getUserRewardHistory()` via HTTP API | `getUserClaimedRewardHistory()` via API + `getLendingRewardsBatch()` devInspect |
| Focus | TX builder + current-state reads | TX builder + on-chain state inspection |

**Old SDK abandoned.** Dependency should be `@naviprotocol/lending`, not `navi-sdk`.

---

## Monorepo Structure

```
naviprotocol-monorepo/
  packages/
    lending/                          # OUR TARGET
      src/
        index.ts                      # Main exports
        types.ts                      # Type definitions (LendingConfig, Pool, LendingReward, etc.)
        config.ts                     # getConfig() — fetches from API
        pool.ts                       # getPools(), getPool(), depositCoinPTB, withdrawCoinPTB, borrowCoinPTB, repayCoinPTB, PoolOperator enum
        account.ts                    # getLendingState(), getHealthFactor(), mergeCoinsPTB(), getUserPositions()
        reward.ts                     # getUserAvailableLendingRewards(), getUserClaimedRewardHistory(), claimLendingRewardsPTB()
        liquidate.ts                  # liquidatePTB()
        flashloan.ts                  # Flash loan operations
        oracle.ts                     # getPriceFeeds(), oracle interactions
        emode.ts                      # E-Mode (efficiency mode) pools
        market.ts                     # Market registry (MARKETS.main, MARKETS.ember, etc.)
        utils.ts                      # Utilities (normalizeCoinType, withCache, parseDevInspectResult, etc.)
        bcs.ts                        # BCS serialization for parsing devInspect results
      tests/                          # Vitest fixtures (account.test.ts, reward.test.ts, pool.test.ts, etc.)
      package.json                    # version 1.4.3
    wallet-client/                    # High-level API for wallet operations
      src/
        modules/
          lendingModule/
            index.ts                  # LendingModule class with event emitters
            navi.ts                   # Navi-specific lending protocol impl
            suilend.ts                # Suilend lending (cross-protocol support)
            protocols/                # Protocol interface + implementations
      package.json                    # version 1.4.8
    astros-aggregator-sdk/            # DEX aggregation (Aftermath, Cetus, etc.)
    astros-bridge-sdk/                # Cross-chain bridging (Mayan)
    astros-dca-sdk/                   # Dollar-cost averaging
    docs/                             # Typedoc documentation website
  pnpm-workspace.yaml
  package.json
```

---

## Concrete Value for Our Tax Decoder

**Moderate-to-high.** Not for event decoding (SDK is write-only + current-state reads), but essential for:

1. **Configuration constants** — `getConfig()` returns `LendingConfig` with:
   - `package` — Navi lending package ID on-chain
   - `storage` — Protocol storage object ID
   - `incentiveV3` — Reward contract address
   - `oracle` → `feeds[]` — Pyth price feeds for all supported tokens
   - `reserveParentId`, `flashloanConfig`, etc.
   - **All of this is dynamic (fetched from API)**, not hardcoded.

2. **Pool metadata** — `getPools()` returns `Pool[]` with:
   - `id` — asset identifier (0-30+ for different tokens)
   - `coinType`, `suiCoinType` — normalized coin types
   - `contract.pool` — on-chain pool object ID
   - `token.decimals`, `token.symbol`, `token.price`
   - **Static snapshot at call time; changes require re-fetch.**

3. **Type definitions** — `LendingReward`, `UserLendingInfo`, `Pool`, `LendingConfig` TypeScript types for parsing devInspect + API responses.

4. **Wallet-client module events** — `@naviprotocol/wallet-client` emits:
   ```typescript
   'lending:deposit-success' → { identifier: AssetIdentifier, amount: number }
   'lending:withdraw-success' → { identifier: AssetIdentifier, amount: number }
   'lending:borrow-success' → { identifier: AssetIdentifier, amount: number }
   'lending:repay-success' → { identifier: AssetIdentifier, amount: number }
   'lending:liquidate-success' → { payIdentifier, payAmount, collateralIdentifier, liquidationAddress }
   'lending:claim-rewards-success' → { rewards: LendingReward[] }
   ```
   **NOT on-chain events.** These are TypeScript event emitters from the SDK's tx builders. Useful for integration tests, not for historical decoding.

---

## Event/Struct Types for On-Chain Events

**NOT in the monorepo.** The SDK does not define Move event types. Why?

- Navi's Move source is **not published** in this repo (unlike Suilend).
- The SDK is **transaction builders** (PTB functions), not event parsers.
- `getConfig()` returns package IDs and addresses; you must query events yourself via `sui_queryEvents` (Sui RPC) using those package IDs.

**Event discovery strategy:**

1. Call `getConfig()` to get `config.package` (main Navi lending package ID on mainnet).
2. Run `sui-events-indexer -p <config.package>` to auto-generate TypeScript event types.
3. Reference Suilend's Move source (`/onchain/suilend/contracts/`) as the semantic baseline (DepositEvent, WithdrawEvent, BorrowEvent, RepayEvent, LiquidateEvent, ClaimRewardEvent patterns), as Navi likely follows similar naming.

**Minimum known events** (inferred from SDK + old navi-sdk constants):
- `DepositEvent` { asset_id?, coin_type?, amount?, ... }
- `WithdrawEvent` { asset_id?, coin_type?, amount?, ... }
- `BorrowEvent` { asset_id?, coin_type?, amount?, origination_fee?, ... }
- `RepayEvent` { asset_id?, coin_type?, amount?, ... }
- `LiquidateEvent` { pay_asset_id?, collateral_asset_id?, liquidator?, liquidatee?, ... }
- `ClaimRewardEvent` { asset_id?, reward_coin_type?, amount?, pool_id?, ... }
- Possibly: `InterestUpdateEvent`, `ReserveAssetDataEvent` (similar to Suilend)

---

## Package/Object IDs on Mainnet

**Fetched dynamically via API, not hardcoded:**

```typescript
const config = await getConfig({ env: 'prod' }); // env='prod' defaults to mainnet
// config.package             — main lending package ID
// config.storage             — protocol storage object
// config.incentiveV3         — reward contract object
// config.oracle.packageId    — oracle package ID
// config.oracle.feeds[]      — Pyth price feeds for each token
```

**Call `getConfig()` on startup**, cache for 5min (default cache: `DEFAULT_CACHE_TIME = 1000 * 60 * 5`), then use returned IDs for event queries.

**File reference:** `/packages/lending/src/config.ts:32-43` (getConfig with caching/singleton wrapper).

---

## Does the SDK Parse Historical Txs?

**No. Write-only + current-state reads.**

What the SDK CAN do:
- Build PTBs for lending operations (deposit, borrow, repay, withdraw, claim rewards).
- Read current state via devInspect: `getLendingState(address)`, `getHealthFactor(address)`, `getUserAvailableLendingRewards(address)`.
- Fetch reward history via **HTTP API**: `getUserClaimedRewardHistory(address, { page, size })` returns paginated claimed reward events.

What the SDK CANNOT do:
- Query historical on-chain events by tx digest.
- Decode parsed events from a tx.
- Introspect transaction flows.

**For tax decoding, you must:**
1. Query Navi's on-chain events via `sui_queryEvents` (using package IDs from `getConfig()`).
2. Parse event `parsedJson` payloads manually or via `sui-events-indexer`.
3. Build your own event handler (matching Suilend's pattern).

---

## haSUI Loop Detection

**No built-in detection.** The SDK's `Aggregator/Dex/haSui.ts` (in wallet-client) only models:
- `staking::request_stake_coin` (haSUI deposit)
- `request_unstake_instant_coin` (haSUI withdrawal)

The **leveraged looping pattern** (deposit haSUI → borrow SUI → stake SUI to haSUI → deposit again) is:
- **Not modeled** in the SDK.
- **Must be detected post-hoc** by analyzing sequential events within a single PTB (transaction block).

**Detection algorithm sketch:**
1. Find DepositEvent(coin_type=haSUI) + BorrowEvent(coin_type=SUI) in same tx.
2. Follow with haSUI mint event (stake SUI → haSUI).
3. Recurrence = leveraged loop iteration.
4. Tag as `haSUI_loop` with loop depth for tax reporting.

File reference (old navi-sdk, for reference only): `/onchain/navi-sdk/src/libs/Aggregator/Dex/haSui.ts` shows the staking/unstaking calls, not looping logic.

---

## Rewards/Points System

**Two APIs:**

### API 1: `getUserAvailableLendingRewards(address)`

**File:** `/packages/lending/src/reward.ts:166-207`

```typescript
export async function getUserAvailableLendingRewards(
  address: string | AccountCap,
  options?: Partial<SuiClientOption & EnvOption & MarketsOption>
): Promise<LendingReward[]>
```

Returns claimable rewards via devInspect of the `incentive_v3_getter::get_user_atomic_claimable_rewards` Move call.

**Shape of `LendingReward`:**
```typescript
{
  userClaimableReward: number
  userClaimedReward?: string
  option: number                      // reward type ID
  ruleIds: string[]                   // rule identifiers
  assetCoinType: string               // token deposited/borrowed (e.g., '0x2::sui::SUI')
  rewardCoinType: string              // reward token (e.g., NAVX)
  assetId: number                     // pool ID
  market: string                      // market key ('main', 'ember', etc.)
  owner: string                       // user address
  address: string                     // account cap (if eMode)
  emodeId?: number
}
```

### API 2: `getUserClaimedRewardHistory(address, { page, size })`

**File:** `/packages/lending/src/reward.ts:300-319`

Fetches from `https://open-api.naviprotocol.io/api/navi/user/rewards`:

```typescript
export const getUserClaimedRewardHistory = withSingleton(
  async (
    address: string | AccountCap,
    options?: Partial<MarketOption & { page: number; size: number }>
  ): Promise<{ data: HistoryClaimedReward[] }>
)
```

**Shape of `HistoryClaimedReward`:**
```typescript
{
  amount: string
  coinType: string
  pool: string
  sender: string
  timestamp: string                   // Unix epoch (seconds or ms?)
  tokenPrice: number
}
```

**This is centralized (Navi's HTTP API), not on-chain events.**

### Reward Claiming PTB

**File:** `/packages/lending/src/reward.ts:337-400+`

```typescript
export async function claimLendingRewardsPTB(
  tx: Transaction,
  rewards: LendingReward[],
  options?: Partial<...>
): Promise<LendingClaimedReward[]>
```

Groups rewards by coin type, calls `incentive_v3::claim_reward*` Move function. Returned coins + transaction emits `lending:claim-rewards-success` event.

---

## API Changes vs Old navi-sdk

| Feature | Old SDK | New SDK |
|---|---|---|
| Entry class | `NAVISDKClient` class | Function-based API (no class) |
| Config | Static `address.ts` exports | Dynamic `getConfig()` API call |
| Coin type mapping | `AddressMap` (hardcoded) | Derived from `getPools().token.symbol` |
| Lending ops | `SDK.deposit()`, `SDK.borrow()`, etc. | `depositCoinPTB()`, `borrowCoinPTB()` (PTB builders) |
| Account state | `getAddressPortfolio()` | `getLendingState()` (same concept, different API) |
| Reward history | `getUserRewardHistory()` | `getUserClaimedRewardHistory()` (paginated, same API endpoint) |
| Liquidation | `liquidatePTB()` exists | `liquidatePTB()` exists (API unchanged) |
| Flash loans | `flashLoanPTB()` | `flashLoanPTB()` (API similar) |

**Breaking changes for us:**
1. **Package ID now dynamic** — can't hardcode `0xee00...` in code. Must call `getConfig()` on startup and cache.
2. **Class → functions** — old SDK: `sdk.deposit(pool, amount)`. New SDK: `const tx = new Transaction(); await depositCoinPTB(tx, pool, coin)`. Slightly more verbose but more composable.
3. **AccountCap handling** — new SDK explicitly models account capability objects; needed for E-Mode pools.
4. **Multi-market support** — new SDK (monorepo) supports multiple markets (main, ember, etc.); old SDK was single-market.

---

## What to Lift Verbatim

1. **Type definitions** — Import `LendingReward`, `Pool`, `LendingConfig`, `UserLendingInfo` from `@naviprotocol/lending` types.ts. These are well-designed and stable.

2. **Utility functions** — Consider importing or copying:
   - `normalizeCoinType()` — standardize coin type addresses (remove leading 0x, etc.)
   - `parseTxValue()` — handle mixed input types (number, TransactionResult)
   - `withCache()`, `withSingleton()` — caching wrappers (but simpler for our use case)

3. **Pool/config fetching** — If we want live mainnet pool data:
   ```typescript
   import { getPools, getConfig } from '@naviprotocol/lending';
   const pools = await getPools({ env: 'prod' });
   const config = await getConfig({ env: 'prod' });
   ```
   Cache these on startup (5min TTL sufficient for tax decoder).

4. **Reward history API** — If centralized reward history is acceptable (rather than on-chain event parsing):
   ```typescript
   import { getUserClaimedRewardHistory } from '@naviprotocol/lending';
   const history = await getUserClaimedRewardHistory(address, { page: 1, size: 400 });
   ```
   Caveat: This is **not on-chain**; it hits Navi's HTTP API. Only safe for reward claim events; may miss other actions.

---

## What to Build from Scratch

1. **Event type definitions** — We must define Move struct types for Navi's on-chain events. Bootstrap via `sui-events-indexer`.

2. **Event query loop** — Query Navi's events via `sui_queryEvents(filter: { MoveEventModule: { package: config.package } })` for each action type.

3. **Event parser** — Decode event `parsedJson` and map to our canonical `TaxEvent` type.

4. **haSUI loop detection** — Analyze sequential events within a tx to spot leverage loops.

5. **Decimal scaling** — Pool info includes decimals; use to convert raw on-chain amounts to human-readable values.

6. **Position lifecycle tracking** — Track deposit/borrow per pool + address to compute cost basis, holding periods, etc.

---

## Integration Sketch

```typescript
import { getPools, getConfig, getUserClaimedRewardHistory } from '@naviprotocol/lending';

// 1. On startup
const config = await getConfig({ env: 'prod' });  // cache for 5min
const pools = await getPools({ env: 'prod' });    // cache for 5min
console.log('Navi package ID:', config.package);   // e.g., 0x123abc...

// 2. Build event query filter using package ID from config
const eventFilter = {
  MoveEventModule: {
    package: config.package
  }
};

// 3. Query events via @mysten/sui SDK
import { SuiClient } from '@mysten/sui/client';
const client = new SuiClient({ url: 'https://fullnode.mainnet.sui.io' });
const events = await client.queryEvents({
  query: eventFilter,
  limit: 1000
});

// 4. Decode events
for (const event of events.data) {
  const typename = event.type;  // e.g., '0x123::pool::DepositEvent'
  const payload = event.parsedJson;
  
  // Parse based on typename; map to TaxEvent
  // (implement event handler matching Suilend pattern)
}

// 5. (Optional) Fetch reward history from API
const rewardHistory = await getUserClaimedRewardHistory(address, { page: 1, size: 400 });
// Compare against on-chain ClaimRewardEvent queries for coverage validation
```

---

## Gaps

1. **No event definitions in SDK** — Event types must be reverse-engineered via `sui-events-indexer` or by inspecting actual transactions.
2. **No historical event indexer** — SDK provides current state + recent API history; no off-chain indexer included.
3. **Centralized reward history API** — `getUserClaimedRewardHistory()` hits Navi's HTTP endpoint, not fully on-chain queryable.
4. **No haSUI looping model** — We must detect leveraged loops post-hoc.
5. **Multi-market complexity** — Monorepo supports markets (main, ember); we must handle pool ID collisions if indexing across markets (unlikely but check).

---

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Direct reuse | 3/5 | Config/pool fetching, type defs reusable; no event parsing |
| Architectural inspiration | 3/5 | PTB builder pattern clean; devInspect + caching approach instructive |
| Domain fit | 4/5 | Covers the right protocol; well-structured APIs |
| Maintenance health | 5/5 | Active development, recent commits, npm packages published |
| **Overall** | **3/5** | **Essential for config + address constants; event decoding built from scratch** |

---

## Top 3-5 Files to Read (Priority Order)

1. `/packages/lending/src/config.ts` — getConfig() API + LendingConfig shape; understand how package IDs are fetched (file:32-43).
2. `/packages/lending/src/types.ts` — LendingConfig, Pool, LendingReward, UserLendingInfo type definitions (file:13-523).
3. `/packages/lending/src/pool.ts` — getPools(), getPool(), pool operations (deposit/borrow/repay PTBs); references to Move call targets (file:70-197).
4. `/packages/lending/src/reward.ts` — getUserClaimedRewardHistory(), getUserAvailableLendingRewards(), shape of reward data (file:300-319, 166-207).
5. `/packages/wallet-client/src/modules/lendingModule/index.ts` — Event emitters + operation flow; shows how SDK is used in practice (file:58-106).

---

## Dependency Advice

```json
{
  "dependencies": {
    "@naviprotocol/lending": "^1.4.3",
    "@mysten/sui": ">=1.25.0"
  }
}
```

**Note:** Wallet-client depends on lending; if using wallet-client, it auto-imports lending. For tax decoder, just depend on lending directly.

