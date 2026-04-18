# aave-v3-core

**Location:** ~/Code/Misc/onchain/aave-v3-core
**Language:** Solidity 0.8.10 (Hardhat/TS test harness)
**License:** BSL-1.1 with Additional Use Grant, Change License MIT (change date 2023-01-27 — so effectively MIT for our use today)
**Maintenance:** Official Aave repo; maintenance slowed as focus moved to v3.1 / v3.2 / Aave SDK v4 — but v3 is what's deployed on Base.

## Purpose
The canonical Aave V3 core contracts — `Pool`, `AToken`, `StableDebtToken`, `VariableDebtToken`, and all the reserve/liquidation/borrow/supply logic libraries. Cloned as the source of truth for event signatures and data types used by our Aave handler.

## What it gives us
- `IPool.sol` — complete event signatures for every tax-relevant action:
  - `Supply(reserve, user, onBehalfOf, amount, referralCode)`
  - `Withdraw(reserve, user, to, amount)`
  - `Borrow(reserve, user, onBehalfOf, amount, interestRateMode, borrowRate, referralCode)`
  - `Repay(reserve, user, repayer, amount, useATokens)`
  - `FlashLoan(...)`
  - `LiquidationCall(collateralAsset, debtAsset, user, debtToCover, liquidatedCollateralAmount, liquidator, receiveAToken)`
  - `MintUnbacked`, `BackUnbacked`, `IsolationModeTotalDebtUpdated`, `UserEModeSet`, `ReserveDataUpdated`
- `IAToken.sol`, `IVariableDebtToken.sol`, `IStableDebtToken.sol` — the token events (`Mint`, `Burn`, `BalanceTransfer`) that actually reflect interest accrual (scaled balances → reward/interest tracking).
- `DataTypes.sol` — `ReserveData`, `UserConfigurationMap`, `ReserveConfigurationMap` struct layouts that match `Pool.getReserveData()` / `getUserConfiguration()` returns.
- `ReserveLogic.sol`, `SupplyLogic.sol`, `BorrowLogic.sol`, `LiquidationLogic.sol` — canonical implementations of how liquidityIndex / variableBorrowIndex accrue, how collateral/debt positions update on each action. Reference for reconstructing scaled → actual balances.
- `WadRayMath.sol` — ray (1e27) / wad (1e18) fixed-point math used for indexes.

## How we'd use it in our decoder
- Paste the six Pool events (`Supply`, `Withdraw`, `Borrow`, `Repay`, `FlashLoan`, `LiquidationCall`) into a viem `parseAbi([...])` array. Call `getLogs({ address: POOL, topics: [eventTopic, null, userTopic] })` per wallet to enumerate every Aave action.
- Use `Pool.getReserveData(asset)` / `Pool.getUserAccountData(user)` views to snapshot position state at a given block.
- For interest accrual (which IS a taxable event in many jurisdictions when realized), use `AToken.scaledBalanceOf(user)` × reserve `liquidityIndex` at the query block; aave-utilities' `formatUserSummary` already does this — we prefer to use that rather than reimplement.
- Treat this repo primarily as the Solidity source-of-truth for ABIs and for verifying what fields like `liquidityIndex` or `scaledBalance` mean.

## Key files
- `~/Code/Misc/onchain/aave-v3-core/contracts/interfaces/IPool.sol` — tax-relevant events + view signatures
- `~/Code/Misc/onchain/aave-v3-core/contracts/interfaces/IAToken.sol` / `IVariableDebtToken.sol` / `IStableDebtToken.sol`
- `~/Code/Misc/onchain/aave-v3-core/contracts/protocol/libraries/types/DataTypes.sol` — struct layouts
- `~/Code/Misc/onchain/aave-v3-core/contracts/protocol/libraries/logic/SupplyLogic.sol` / `BorrowLogic.sol` / `LiquidationLogic.sol` — accrual/index update reference
- `~/Code/Misc/onchain/aave-v3-core/contracts/protocol/libraries/math/WadRayMath.sol` — fixed-point helpers
- `~/Code/Misc/onchain/aave-v3-core/contracts/protocol/pool/Pool.sol` — top-level entrypoint (for matching calldata selectors)

## Gaps
- No shipped TS ABIs; we compile or paste into viem manually. (`aave-utilities` ships typechain-generated TS types — easier.)
- No Base-specific addresses here; use `@bgd-labs/aave-address-book` (referenced in aave-utilities README).
- Source only shows how scaled balances are computed; actual USD pricing and health-factor math lives in `aave-v3-periphery`'s `UiPoolDataProviderV3` and in `aave-utilities`' `math-utils`.
- BSL license technicality — the change date has passed (2023-01-27), so it's MIT now, but worth noting if this changes.

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Direct reuse (artifacts: ABIs, TS types, schemas) | 3/5 | Source only; ABIs derivable but must compile or hand-extract. |
| Code pattern inspiration | 5/5 | Definitive semantics for all Aave events/indexes. |
| Domain fit (Base chain specifically) | 5/5 | Same bytecode deployed on Base. |
| Maintenance health | 3/5 | Frozen-ish but official; v3.1/v3.2 live elsewhere. |
| **Overall** | **4/5** | Indispensable as source of truth, but daily work goes through aave-utilities. |
