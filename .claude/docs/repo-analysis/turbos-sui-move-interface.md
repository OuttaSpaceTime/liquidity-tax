# turbos-sui-move-interface

**Location:** ~/Code/Misc/defi-tracker/onchain/turbos-sui-move-interface
**Language:** Move (Sui Move)
**Repository State:** Published contract interface (abstracted/verified, not live source)
**Canonical Published Address (Mainnet):** `0xa5a0c25c79e428eba04fb98b3fb2a34db45ab26d4c8faf0d7e39d66a63891e64`
**Canonical Package Address (Mainnet):** `0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1`
**Version:** 0.1.8 (as of last repo sync 2026-04-18)
**License:** MIT
**Maintenance:** Actively maintained; CHANGELOG shows steady incremental deployments through 2025. Latest version tagged 2025-08-12 (implied from SDK CHANGELOG in sibling repo).

## Purpose

Canonical on-chain Move interface for Turbos Finance CLMM (concentrated-liquidity market-maker) on Sui. This is **not the complete implementation source code** — it's a published/verified snapshot where function bodies are abstracted (`abort 0`). The repo serves two purposes:

1. **Reference for Move struct definitions** — pool, position, tick, fee, reward objects
2. **Canonical entry function signatures** — mint, burn, increase_liquidity, decrease_liquidity, collect_fee, collect_reward, swap operations

For event type discovery and full implementation details, must use either:
- `sui-events-indexer` to extract event types from deployed bytecode
- `suiClient.getNormalizedMoveModulesByPackage()` to fetch published module metadata
- Actual on-chain transactions to reverse-engineer event payloads

## Module Structure

```
clmm/sources/
  pool.move              # Core pool state (liquidity, ticks, fee/reward tracking)
  position_manager.move  # Position NFT lifecycle (mint, burn, add/remove liquidity)
  position_nft.move      # TurbosPositionNFT object definition
  pool_factory.move      # Pool creation and configuration
  swap_router.move       # Swap entry points (single-pool and multi-hop)
  fee.move              # Fee tier definitions
  partner.move          # Partner fee split mechanism
  lib/                  # Math libraries (tick, liquidity, sqrt-price, swap mechanics)
    math_tick.move
    math_liquidity.move
    math_sqrt_price.move
    math_swap.move
    i32.move / i128.move / i256.move  # Signed integer types
    full_math_u*.move                  # Precision arithmetic
    math_bit.move
    string_tools.move
```

## Key Data Structures

### Pool Object

**File:** `pool.move:79-99`

```move
struct Pool<phantom CoinTypeA, phantom CoinTypeB, phantom FeeType> has key, store {
    id: UID,
    coin_a: Balance<CoinTypeA>,
    coin_b: Balance<CoinTypeB>,
    protocol_fees_a: u64,
    protocol_fees_b: u64,
    sqrt_price: u128,                  // Current sqrt(price) in Q64.64
    tick_current_index: I32,           // Current tick (signed)
    tick_spacing: u32,                 // Tick granularity (1, 2, 5, 10, etc.)
    max_liquidity_per_tick: u128,      // Safety limit per tick
    fee: u32,                          // Swap fee in basis points (500 = 0.05%)
    fee_protocol: u32,                 // Protocol fee split ratio
    unlocked: bool,                    // Reentrancy guard
    fee_growth_global_a: u128,         // Fee growth per unit liquidity (CoinA)
    fee_growth_global_b: u128,         // Fee growth per unit liquidity (CoinB)
    liquidity: u128,                   // Current active liquidity
    tick_map: Table<I32, u256>,        // Bitmap of initialized ticks
    deploy_time_ms: u64,               // Pool creation timestamp (ms)
    reward_infos: vector<PoolRewardInfo>, // Active reward programs
    reward_last_updated_time_ms: u64,  // Last reward update time
}
```

### Position Object (In-Pool)

**File:** `pool.move:52-63`

```move
struct Position has key, store {
    id: UID,
    liquidity: u128,                   // Amount of liquidity owned
    fee_growth_inside_a: u128,         // Snapshot of fee growth (CoinA)
    fee_growth_inside_b: u128,         // Snapshot of fee growth (CoinB)
    tokens_owed_a: u64,                // Accumulated unclaimed fees (CoinA)
    tokens_owed_b: u64,                // Accumulated unclaimed fees (CoinB)
    reward_infos: vector<PositionRewardInfo>, // Per-reward tracking
}
```

### Position NFT (User-Facing)

**File:** `position_nft.move:16-26`

```move
struct TurbosPositionNFT has key, store {
    id: UID,
    name: String,
    description: String,
    img_url: Url,
    pool_id: ID,         // Reference to pool this position belongs to
    position_id: ID,     // ID of in-pool Position object
    coin_type_a: TypeName,   // First coin in pair
    coin_type_b: TypeName,   // Second coin in pair
    fee_type: TypeName,      // Fee tier marker
}
```

### Tick Object

**File:** `pool.move:37-45`

```move
struct Tick has key, store {
    id: UID,
    liquidity_gross: u128,        // Total liquidity crossing this tick
    liquidity_net: I128,          // Signed liquidity delta (entering/exiting range)
    fee_growth_outside_a: u128,   // Cumulative fee growth below tick (CoinA)
    fee_growth_outside_b: u128,   // Cumulative fee growth below tick (CoinB)
    reward_growths_outside: vector<u128>, // Per-reward growth below tick
    initialized: bool,            // Whether tick has been crossed
}
```

## Entry Functions — Position Lifecycle

All these are exposed as `public entry fun` in `position_manager.move`. They correspond to the Move-call targets the SDK documents (see `turbos-clmm-sdk.md` list).

### Position Creation

**File:** `position_manager.move:102-122`

```move
public entry fun mint<CoinTypeA, CoinTypeB, FeeType>(
    pool: &mut Pool<...>,
    positions: &mut Positions,
    coins_a: vector<Coin<CoinTypeA>>,
    coins_b: vector<Coin<CoinTypeB>>,
    tick_lower_index: u32,
    tick_lower_index_is_neg: bool,
    tick_upper_index: u32,
    tick_upper_index_is_neg: bool,
    amount_a_desired: u64,
    amount_b_desired: u64,
    amount_a_min: u64,
    amount_b_min: u64,
    recipient: address,
    deadline: u64,
    clock: &Clock,
    versioned: &Versioned,
    ctx: &mut TxContext
)
```

**Tax event:** OpenPosition (or MintEvent if emitted)
**Key inputs:** tick_lower_index, tick_upper_index (range), amounts desired + minimums (slippage protection)
**Outputs:** TurbosPositionNFT returned to recipient
**Associated events to discover:** Event emitted with position_id, pool_id, amounts_actual (not desired), liquidity minted

### Liquidity Addition

**File:** `position_manager.move:133-149`

```move
public entry fun increase_liquidity<CoinTypeA, CoinTypeB, FeeType>(
    pool: &mut Pool<...>,
    positions: &mut Positions,
    coins_a: vector<Coin<CoinTypeA>>,
    coins_b: vector<Coin<CoinTypeB>>,
    nft: &mut TurbosPositionNFT,
    amount_a_desired: u64,
    amount_b_desired: u64,
    amount_a_min: u64,
    amount_b_min: u64,
    deadline: u64,
    clock: &Clock,
    versioned: &Versioned,
    ctx: &mut TxContext
)
```

**Tax event:** AddLiquidity
**Key inputs:** nft (position identifier), amounts desired + minimums
**Associated events to discover:** Event with position_id, amounts_actual, liquidity_delta

### Liquidity Removal

**File:** `position_manager.move:151-164`

```move
public entry fun decrease_liquidity<CoinTypeA, CoinTypeB, FeeType>(
    pool: &mut Pool<...>,
    positions: &mut Positions,
    nft: &mut TurbosPositionNFT,
    liquidity: u128,           // Amount of liquidity to withdraw
    amount_a_min: u64,
    amount_b_min: u64,
    deadline: u64,
    clock: &Clock,
    versioned: &Versioned,
    ctx: &mut TxContext
)
```

**Tax event:** RemoveLiquidity
**Key inputs:** nft (position), liquidity amount (raw LP units, NOT underlying amounts)
**Associated events to discover:** Event with position_id, amounts_returned_a/b, liquidity_delta

### Fee Collection

**File:** `position_manager.move:181-194`

```move
public entry fun collect<CoinTypeA, CoinTypeB, FeeType>(
    pool: &mut Pool<...>,
    positions: &mut Positions,
    nft: &mut TurbosPositionNFT,
    amount_a_max: u64,
    amount_b_max: u64,
    recipient: address,
    deadline: u64,
    clock: &Clock,
    versioned: &Versioned,
    ctx: &mut TxContext
)
```

**Tax event:** HarvestFees or CollectEvent
**Key inputs:** nft, amount_a_max/amount_b_max (collectors get min(owed, max))
**Associated events to discover:** Event with position_id, amount_a_collected, amount_b_collected

### Reward Collection

**File:** `position_manager.move:212-226`

```move
public entry fun collect_reward<CoinTypeA, CoinTypeB, FeeType, RewardCoin>(
    pool: &mut Pool<...>,
    positions: &mut Positions,
    nft: &mut TurbosPositionNFT,
    vault: &mut PoolRewardVault<RewardCoin>,
    reward_index: u64,        // Which reward stream (pool may have multiple)
    amount_max: u64,
    recipient: address,
    deadline: u64,
    clock: &Clock,
    versioned: &Versioned,
    ctx: &mut TxContext
)
```

**Tax event:** HarvestRewards or RewardCollectEvent
**Key inputs:** nft, reward_index (which reward token), amount_max
**Associated events to discover:** Event with position_id, reward_coin_type, amount_collected

### Position Closure

**File:** `position_manager.move:124-131`

```move
public entry fun burn<CoinTypeA, CoinTypeB, FeeType>(
    positions: &mut Positions,
    nft: TurbosPositionNFT,    // Consumes the NFT (takes ownership, not ref)
    versioned: &Versioned,
    ctx: &mut TxContext
)
```

**Tax event:** ClosePosition
**Key inputs:** nft (burned/deleted)
**Associated events to discover:** Event marking position as closed (likely just records the fact, no amounts)
**Lifecycle note:** To close a position:
  1. Call `decrease_liquidity` with full `liquidity` amount (exits price range)
  2. Call `collect` to harvest any remaining fees
  3. Call `burn` to delete the NFT
  Each step emits an event; the three together form a "position closure transaction"

## Swap Entry Functions

**File:** `swap_router.move`

Single-pool swaps:
- `swap_a_b` (swap CoinA for CoinB, entry point)
- `swap_b_a` (swap CoinB for CoinA, entry point)
- `swap_a_b_with_return_` (non-entry, returns coins)
- `swap_b_a_with_return_` (non-entry, returns coins)

Multi-hop swaps (2-pool routes):
- `swap_a_b_b_c` (A→B→C route)
- `swap_a_b_c_b` (A→B→C→B diamond route)
- `swap_b_a_b_c` (B→A→B→C route)
- `swap_b_a_c_b` (B→A→C→B diamond route)

Partner swaps (with fee split):
- `swap_with_partner`
- `swap_a_b_with_partner`
- `swap_b_a_with_partner`

**Tax event:** Swap
**Associated events to discover:** SwapEvent with (amount_in, amount_out, fee, sqrt_price_before/after)

## Event Discovery Methodology

**Important:** The published source in this repo has abstracted function bodies (`abort 0`). To discover actual event types, use one of these approaches:

### Approach 1: sui-events-indexer (Recommended for bootstrap)

```bash
npm install -g sui-events-indexer
sui-events-indexer generate \
  -p 0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1 \
  --name turbos \
  --network mainnet
```

This will:
1. Fetch package bytecode from Sui mainnet
2. Disassemble bytecode and find all `event::emit<T>` calls
3. Extract event struct definitions
4. Generate TypeScript interfaces for each event type
5. Output to `types/` directory (harvest these for our decoder)

**Expected output:** Approximately 10-15 event types (mint, burn, increase_liquidity, decrease_liquidity, collect_fee, collect_reward, swap, and variants).

### Approach 2: suiClient.getNormalizedMoveModulesByPackage()

```typescript
const modules = await suiClient.getNormalizedMoveModulesByPackage({
  package: '0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1',
});

// Iterate modules, extract structs with drop ability (events have `copy, drop`)
// Filter by struct name pattern `*Event` or check emitted in module code
```

### Approach 3: Query Real Transactions

Execute a sample mint/swap/collect on testnet, then inspect:

```typescript
const txBlock = await suiClient.getTransactionBlock({
  digest: '0x...',
  options: { showEvents: true, showEffects: true }
});

// txBlock.events will contain serialized event structs with parsedJson payloads
```

## Expected Event Types (Inferred from SDK + Architecture)

Based on the entry functions and Suilend event patterns, the following event types **should** be emitted:

1. **MintEvent** (or CreatePositionEvent)
   - Fields: `pool_id`, `position_id`, `tick_lower`, `tick_upper`, `amount_a`, `amount_b`, `liquidity`, `owner`
   - Emitted by: `position_manager::mint`
   - Tax interpretation: Open position

2. **IncreaseLiquidityEvent** (or AddLiquidityEvent)
   - Fields: `position_id`, `amount_a`, `amount_b`, `liquidity_delta`, `fee_growth_inside_a`, `fee_growth_inside_b`
   - Emitted by: `position_manager::increase_liquidity`
   - Tax interpretation: Add liquidity

3. **DecreaseLiquidityEvent** (or RemoveLiquidityEvent)
   - Fields: `position_id`, `amount_a`, `amount_b`, `liquidity_delta`, `fee_growth_inside_a`, `fee_growth_inside_b`
   - Emitted by: `position_manager::decrease_liquidity`
   - Tax interpretation: Remove liquidity

4. **CollectFeeEvent** (or HarvestFeeEvent)
   - Fields: `position_id`, `amount_a`, `amount_b`
   - Emitted by: `position_manager::collect`
   - Tax interpretation: Fee collection (reward)

5. **CollectRewardEvent** (or HarvestRewardEvent)
   - Fields: `position_id`, `reward_coin_type`, `amount`
   - Emitted by: `position_manager::collect_reward`
   - Tax interpretation: Reward collection

6. **BurnEvent** (or ClosePositionEvent)
   - Fields: `position_id`, `owner`
   - Emitted by: `position_manager::burn`
   - Tax interpretation: Close position (no amounts — just marks deletion)

7. **SwapEvent**
   - Fields: `pool_id`, `amount_in`, `amount_out`, `fee`, `sqrt_price_before`, `sqrt_price_after`, `tick_before`, `tick_after`, `a_to_b` (bool)
   - Emitted by: `swap_router::swap_*` functions
   - Tax interpretation: Swap

## Fee Tier Structure

**File:** `fee.move` (not shown in limit, but referenced in SDK as Fee config)

Fee tiers are typically:
- 1 bp (0.01%) — stablecoin pairs
- 5 bp (0.05%) — low-volatility pairs
- 30 bp (0.3%) — standard pairs
- 100 bp (1%) — high-volatility pairs

Each fee tier has a corresponding tick spacing (e.g., 1bp → 1 tick, 100bp → 10 ticks), enforced by pool creation validation.

**How to map:** The `fee_type` TypeName on TurbosPositionNFT identifies the tier. Fee amount charged on swaps is stored in `pool.fee` (u32, in basis points).

## Position Lifecycle Correlation

A typical position lifecycle maps to tax events as follows:

```
TX1: position_manager::mint(tick_lower, tick_upper, amount_a, amount_b)
   → MintEvent(position_id=X, amount_a, amount_b, liquidity)
   → TaxEvent(type=DEPOSIT, subtype=LIQUIDITY_MINT, positionId=X)

[Time passes]

TX2: position_manager::increase_liquidity(nft=X, amount_a, amount_b)
   → IncreaseLiquidityEvent(position_id=X, amount_a, amount_b)
   → TaxEvent(type=DEPOSIT, subtype=LIQUIDITY_ADD, positionId=X)

TX3: position_manager::collect(nft=X)
   → CollectFeeEvent(position_id=X, amount_a_fee, amount_b_fee)
   → TaxEvent(type=INCOME, subtype=FEE_HARVEST, positionId=X)
     [Repeat as needed; can collect multiple times without closing]

TX4: position_manager::decrease_liquidity(nft=X, liquidity=50%)
   → DecreaseLiquidityEvent(position_id=X, amount_a, amount_b, liquidity_delta)
   → TaxEvent(type=WITHDRAWAL, subtype=LIQUIDITY_REMOVE, positionId=X)

TX5: position_manager::collect(nft=X) [final harvest]
   → CollectFeeEvent(position_id=X, amount_a_final, amount_b_final)
   → TaxEvent(type=INCOME, subtype=FEE_HARVEST, positionId=X)

TX6: position_manager::decrease_liquidity(nft=X, liquidity=100%)
   → DecreaseLiquidityEvent(position_id=X, amount_a, amount_b, liquidity_delta=0)
   → [No separate tax event; this is the final removal]

TX7: position_manager::burn(nft=X)
   → BurnEvent(position_id=X)
   → TaxEvent(type=EVENT, subtype=POSITION_CLOSED, positionId=X)
     [Marker only; no amounts]
```

**Position ID tracking:** The `position_id` field in all events must be used to correlate events across transactions. It remains constant for the lifetime of a position.

## Comparison to Orca Whirlpool

Turbos and Orca Whirlpool follow the same CLMM design (from Uniswap V3 via Orca's work):

| Aspect | Turbos | Orca |
|---|---|---|
| Event types | ~7 types (expected) | ~6 types (MintEvent, BurnEvent, SwapEvent, etc.) |
| Position tracking | NFT (TurbosPositionNFT) | NFT (WhirlpoolPosition) |
| Fee model | `feeGrowthInside` per position | Same |
| Rewards | Per-position PositionRewardInfo vector | Per-position similar |
| Liquidity math | `math_liquidity.move` | Built into Whirlpool IDL |
| Move-call targets | `position_manager::mint`, etc. | `whirlpool::mint`, etc. |

**Caveat:** Orca has a mature TypeScript SDK with event types already defined. Turbos does not. This repo provides the Move interface spec, but event DTO generation is a separate bootstrapping step.

## Integration Path for Decoder

1. **Run sui-events-indexer** against the Turbos package ID to bootstrap TypeScript event type definitions.
2. **Map entry function calls** — classifier recognizes Turbos transactions by package ID + module::function matching (see turbos-clmm-sdk.md integration sketch).
3. **Extract event payloads** — iterate `tx.events`, parse with auto-generated TypeScript event types from step 1.
4. **Position tracking** — maintain a map of `positionId → {openTx, closeTx, events[]}` to correlate lifecycle events across transactions.
5. **Amount extraction** — use event fields (amount_a, amount_b, liquidity) + balanceChanges as fallback for validation.
6. **Fee/reward attribution** — differentiate between `CollectFeeEvent` (trading fees) and `CollectRewardEvent` (external rewards) at tax-mapping time.

## Gaps & Unknowns

1. **Event struct field names** — This analysis infers event types from entry function semantics, but actual field names (e.g., is it `amount_a` or `amount_in`?) must be confirmed via sui-events-indexer or actual transaction inspection.

2. **Multi-hop swap event structure** — Do `swap_a_b_b_c` routes emit:
   - One SwapEvent with the final (A→C) amounts, or
   - Two SwapEvents (one per pool), or
   - Some other structure?
   Requires live transaction inspection.

3. **Partner fee splitting** — Does `swap_with_partner` emit a separate partner fee event, or is fee split implicit in SwapEvent fields?

4. **Reward vault references** — How are reward vaults keyed? Is `vault_id` in `collect_reward_event`, or must we track it from the call arguments?

5. **Flashloan events** — `pool::flash_swap` and `pool::repay_flash_swap` may emit events; not yet analyzed.

6. **Historical performance** — No benchmarks on event volume. A high-activity position may emit 100+ events; ensure decoder can handle bulk event queries efficiently.

## Recommendation for Use

**Primary value:** This repo documents the **canonical Move interface structure** for position objects, pool state, and entry function signatures. **Not** the actual event types or implementation.

**Must-do before coding:**
1. Run `sui-events-indexer generate -p 0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1` to extract the real event types.
2. Inspect a few real Turbos transactions on Sui mainnet to verify event field names and semantics.

**Coding checkpoint:**
- [ ] Event type definitions generated and checked into `liquidity-tax/src/types/turbos/events.ts`
- [ ] 3+ test fixtures (mint+collect, add+remove liquidity, swap) with expected event payloads
- [ ] Move-call classifier + event parser for Turbos handler

## Top Files to Read

1. **`position_nft.move` (full)** — TurbosPositionNFT struct definition; use as reference for position identification in events
2. **`pool.move` (lines 52-99)** — Pool and Position struct definitions; understand fee/reward tracking
3. **`position_manager.move` (lines 48-226)** — All entry function signatures for position lifecycle
4. **`swap_router.move` (full)** — All swap variants (single-pool, multi-hop, partner)
5. **`pool_factory.move` (lines 44-100)** — Pool creation and configuration

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Direct reuse | 1/5 | Move source only; cannot import. Useful as interface reference only. |
| Architectural inspiration | 3/5 | Struct definitions match standard CLMM design; helps understand position lifecycle. |
| Domain fit | 5/5 | This IS the Turbos protocol. |
| Event reference | 3/5 | Infers likely event types from entry functions; requires sui-events-indexer to confirm. |
| Maintenance health | 5/5 | Actively maintained, reflects deployed contract state. |
| **Overall** | **3/5** | **Essential reference for understanding CLMM position model and entry points. Must pair with sui-events-indexer output for event-type bootstrap.** |

## Integration Checklist

- [ ] Clone repo reference in CLAUDE.md ✓ (already noted)
- [ ] Run `sui-events-indexer` against package ID `0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1`
- [ ] Generate TypeScript event interfaces, check into project
- [ ] Write 3+ test fixtures (real txs from mainnet) with event payloads
- [ ] Implement Turbos handler dispatcher
- [ ] Correlate events → TaxEvent mappings (mint→OpenPosition, etc.)
- [ ] Validate against known positions (use SDK to fetch position state, compare with decoded events)
