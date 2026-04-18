# aave-v3-periphery

**Location:** ~/Code/Misc/onchain/aave-v3-periphery
**Language:** Solidity 0.8.10 (Hardhat/TS tooling)
**License:** AGPL-3.0
**Maintenance:** Official Aave repo; deprecated in favor of 3.1 (see CHANGELOG) but still matches what's deployed on Base.

## Purpose
Aave V3 auxiliary contracts — most notably the `UiPoolDataProviderV3` and `UiIncentiveDataProviderV3` "view aggregator" contracts that aave-utilities calls to pull all reserves and user positions in one RPC call. Also houses rewards/incentives controllers and treasury adapters.

## What it gives us
- `UiPoolDataProviderV3.sol` — the single view contract that returns every reserve's config + live state + prices in one call, and every user reserve's scaled balances. This is what `aave-utilities`' `UiPoolDataProvider` wraps.
- `UiIncentiveDataProviderV3.sol` — same pattern for reward emissions and user-claimable incentives.
- `WalletBalanceProvider.sol` — batched ERC-20 balance reads (`batchBalanceOf(users[], tokens[])`). Generally useful for sweeping a wallet's reserve holdings.
- `rewards/` — `RewardsController` event signatures (`RewardsClaimed`, `Accrued`, `RewardOracleUpdated`) for tracking incentive distributions as taxable income.
- `treasury/` — `Collector` contract (protocol fees).
- `WrappedTokenGatewayV3.sol` — the router used for native-ETH supplies/withdrawals; relevant because user txs hit this contract, not `Pool` directly, when ETH is involved.

## How we'd use it in our decoder
- Deploy-address lookup for `UiPoolDataProviderV3` on Base (from `@bgd-labs/aave-address-book`), then either:
  - Call it directly with viem + the ABI from this repo's compile output, OR
  - (Preferred) use `aave-utilities`' `UiPoolDataProvider` wrapper which handles decoding.
- Use `RewardsController` events to decode reward claims as income events.
- When enumerating a user's Aave txs, also check logs emitted by `WrappedTokenGatewayV3` (it wraps/unwraps WETH around Pool calls) so we don't miss native-ETH supplies/withdrawals.

## Key files
- `~/Code/Misc/onchain/aave-v3-periphery/contracts/misc/UiPoolDataProviderV3.sol` — batched reserve/user view
- `~/Code/Misc/onchain/aave-v3-periphery/contracts/misc/UiIncentiveDataProviderV3.sol` — batched incentives view
- `~/Code/Misc/onchain/aave-v3-periphery/contracts/misc/WalletBalanceProvider.sol` — batched balance reads
- `~/Code/Misc/onchain/aave-v3-periphery/contracts/misc/WrappedTokenGatewayV3.sol` — ETH gateway
- `~/Code/Misc/onchain/aave-v3-periphery/contracts/rewards/RewardsController.sol` — incentives / income events
- `~/Code/Misc/onchain/aave-v3-periphery/contracts/misc/interfaces/IUiPoolDataProviderV3.sol` — the struct returned by the view

## Gaps
- Again no precompiled TS artifacts in repo root; aave-utilities ships typechain bindings for exactly these contracts, so there's no reason to compile ourselves.
- No Base deploy addresses here; get those from `@bgd-labs/aave-address-book`.
- Does not cover the actual lending logic (that's in aave-v3-core).

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Direct reuse (artifacts: ABIs, TS types, schemas) | 3/5 | Source for data-provider ABIs; effectively consumed via aave-utilities. |
| Code pattern inspiration | 3/5 | Useful to confirm what UiPoolDataProvider returns; not much to copy. |
| Domain fit (Base chain specifically) | 5/5 | Deployed on Base. |
| Maintenance health | 2/5 | Deprecated for 3.1; still matches deployed bytecode. |
| **Overall** | **3/5** | Supporting reference behind aave-utilities. |
