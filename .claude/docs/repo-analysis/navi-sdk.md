# navi-sdk

**Location:** ~/Code/Misc/defi-tracker/onchain/navi-sdk
**Language:** TypeScript
**License:** Apache 2.0
**Maintenance:** Last commit 2025-11-17 (merge PR #143 -- update lending package). Active maintenance as of late 2025.

## Purpose
Official TypeScript SDK for Navi Protocol on Sui. Provides account management, lending operations (deposit, withdraw, borrow, repay, liquidate, flash loan), DEX aggregation across Sui DEXes, bridge integration, and pool info queries. npm package name: `navi-sdk` (v1.6.23).

## Architecture
```
src/
  naviSDK.ts              # Main client class (NAVISDKClient)
  address.ts              # Protocol addresses, pool configs, coin type mappings
  types/index.ts          # Pool, PoolConfig, CoinInfo type definitions
  libs/
    AccountManager/       # Wallet management, all lending operations
    CallFunctions/        # On-chain read calls (getAddressPortfolio, getHealthFactor, getReserveData)
    PTB/                  # Programmable Transaction Block builders for all operations
      commonFunctions.ts  # deposit, withdraw, borrow, repay, liquidate, flash loan PTBs
      V3.ts               # V3 pool APY, borrow fee queries
      migrate.ts          # Position migration utilities
    PoolInfo/             # Pool data fetching (via Navi HTTP API + on-chain reads)
    Aggregator/           # DEX swap routing across Sui DEXes
      Dex/haSui.ts        # haSUI stake/unstake swap integration
      Dex/springSui.ts    # SpringSui stake/unstake
    Coins/                # Coin balance and decimal utilities
    Bridge/               # Cross-chain bridge via Mayan
examples/                 # Aggregator demo, flash loan demo, liquidation bot
test/                     # deposit, withdraw, borrow, repay, claim reward, flash loan tests
```

## Concrete value for our decoder

**Limited.** This SDK is designed for **executing** Navi operations and **reading current state**, not for decoding transaction history or events.

What it provides:
- `address.ts`: Complete mapping of Navi pool configs including package IDs, pool IDs, coin types, and parent object IDs for all ~30 supported tokens. This is essential reference data.
- `AddressMap`: Maps coin type addresses to human-readable names (Sui, NAVX, vSui, haSui, wUSDC, USDT, WETH, etc.)
- Pool structure: `PoolConfig` with `assetId`, `poolId`, `type` (coin type), `reserveObjectId`, `borrowBalanceParentId`, `supplyBalanceParentId`

What it does NOT provide:
- No transaction parsing or event decoding
- No historical event querying
- `getUserRewardHistory()` hits Navi's HTTP API (`open-api.naviprotocol.io`), not on-chain events
- `getAddressPortfolio()` reads current balances via `getDynamicFieldObject`, not historical positions

**haSUI handling:** The `Dex/haSui.ts` file is only a DEX swap route for staking/unstaking haSUI via Haedal's `staking::request_stake_coin` / `request_unstake_instant_coin`. It does NOT model or detect the haSUI leverage looping pattern (deposit haSUI -> borrow SUI -> stake SUI to haSUI -> deposit again). That pattern must be inferred from sequential on-chain events.

**Can import as npm dep:** Yes (`npm install navi-sdk`), but only useful for address constants and pool configs, not for our core decoding task.

## Integration sketch
Import `navi-sdk` as a dependency solely for its address/pool config data: coin type mappings, pool IDs, asset IDs. Use these constants when building our Navi event handler to map `coin_type` fields in events to human-readable token names. For the actual decoding, query Navi's on-chain events via `@mysten/sui` SDK using the package IDs from `address.ts`.

## Gaps
- Zero event decoding -- we build all Navi event parsing from scratch
- No documentation of Navi's on-chain event types (must reverse-engineer from the Navi Move contracts, which are NOT in this repo)
- haSUI looping pattern is entirely unmodeled -- needs custom detection logic
- The SDK's dependency on Navi's HTTP API for reward history means it won't work offline or for historical data beyond what the API exposes
- No way to get the Navi Move package source from this repo to discover event struct definitions

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Direct reuse | 2/5 | Address constants and coin mappings are reusable; nothing else |
| Architectural inspiration | 2/5 | PTB builder pattern is interesting but irrelevant to decoding |
| Domain fit | 3/5 | Covers the right protocol but wrong axis (execution vs. decoding) |
| Maintenance health | 4/5 | Active development, recent commits, versioned npm package |
| **Overall** | **2/5** | **Useful as an address/config reference, not for core decoding** |

## Top 3-5 files to read
- `/home/felix/Code/Misc/defi-tracker/onchain/navi-sdk/src/address.ts` -- All pool configs, package IDs, coin type mappings
- `/home/felix/Code/Misc/defi-tracker/onchain/navi-sdk/src/types/index.ts` -- Pool, PoolConfig, CoinInfo type definitions
- `/home/felix/Code/Misc/defi-tracker/onchain/navi-sdk/src/libs/CallFunctions/index.ts` -- On-chain read patterns (getAddressPortfolio, getReservesDetail)
- `/home/felix/Code/Misc/defi-tracker/onchain/navi-sdk/src/libs/Aggregator/Dex/haSui.ts` -- haSUI stake/unstake Move calls (swap routing, not looping)
- `/home/felix/Code/Misc/defi-tracker/onchain/navi-sdk/src/libs/PoolInfo/index.ts` -- Pool data fetching and Navi API integration
