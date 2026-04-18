# v3-periphery

**Location:** ~/Code/Misc/onchain/v3-periphery
**Language:** Solidity (with Hardhat/TS tooling)
**License:** GPL-2.0-or-later
**Maintenance:** Low-activity but official Uniswap Labs repo (last commit 2024-07-25). V3 is frozen; the contract surface is stable and still deployed on Base.

## Purpose
The canonical Uniswap V3 periphery contracts — most importantly `NonfungiblePositionManager` (NPM), the ERC-721 that wraps every V3 LP position. We cloned it for the position interfaces, event signatures, and NPM ABI.

## What it gives us
- `INonfungiblePositionManager.sol` — the definitive event signatures for `IncreaseLiquidity`, `DecreaseLiquidity`, `Collect`, plus the `positions(tokenId)` view struct. These are the three events we must decode for every V3 LP tax event.
- `positions(tokenId)` view returns: `(nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1)` — exactly what we call via viem to snapshot position state.
- `MintParams` / `IncreaseLiquidityParams` / `DecreaseLiquidityParams` / `CollectParams` structs for decoding input calldata if we ever need that.
- Libraries in `contracts/libraries/` (e.g. `LiquidityAmounts.sol`, `PoolAddress.sol`) — `LiquidityAmounts.getAmountsForLiquidity` is the reference implementation of the liquidity→(amount0, amount1) math.

## How we'd use it in our decoder
- Compile/export the NPM ABI (or pull it straight from `artifacts/` after `yarn compile`, or use the npm package `@uniswap/v3-periphery`) and hand it to viem:
  - `parseAbiItem` on `IncreaseLiquidity`, `DecreaseLiquidity`, `Collect` to decode logs from `getLogs({ address: NPM, topics: [...] })`.
  - `readContract({ abi: NPM_ABI, functionName: 'positions', args: [tokenId] })` to fetch current position state at any block.
  - `ownerOf(tokenId)` / `tokenOfOwnerByIndex(owner, i)` (inherited from ERC721Enumerable) to enumerate a wallet's V3 positions.
- For Aerodrome slipstream: slipstream's `NonfungiblePositionManager` is a fork with the same event layout, so decoding code is shareable — we just point at a different address and ABI copy.

## Key files
- `~/Code/Misc/onchain/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol` — events + `positions()` view + action structs
- `~/Code/Misc/onchain/v3-periphery/contracts/NonfungiblePositionManager.sol` — implementation (event emission sites, for sanity-checking)
- `~/Code/Misc/onchain/v3-periphery/contracts/libraries/LiquidityAmounts.sol` — `getAmountsForLiquidity(sqrtPriceX96, sqrtRatioAX96, sqrtRatioBX96, liquidity)`
- `~/Code/Misc/onchain/v3-periphery/contracts/libraries/PoolAddress.sol` — deterministic pool address from `(factory, token0, token1, fee)`
- `~/Code/Misc/onchain/v3-periphery/contracts/libraries/PositionKey.sol` — `keccak256(owner, tickLower, tickUpper)` position key
- `~/Code/Misc/onchain/v3-periphery/contracts/interfaces/IQuoter.sol` / `IQuoterV2.sol` — if we need to quote token amounts without simulating

## Gaps
- No ABIs shipped precompiled in the repo root; we need `yarn && yarn compile` or pulling from the npm `@uniswap/v3-periphery` artifacts. Alternatively we can paste the events into a viem `parseAbi([...])` array manually (they are short).
- No Base-specific deployment addresses — we get those from Uniswap docs or `@uniswap/sdk-core` (NPM on Base is `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1`).
- Solidity source only; no TS helpers beyond tests. Fee accounting math must still be written (tokensOwed is updated only on `poke`/`collect`; real-time unclaimed fees require the feeGrowth calculation from v3-core or the subgraph).

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Direct reuse (artifacts: ABIs, TS types, schemas) | 4/5 | Canonical source of truth for events and position ABI. |
| Code pattern inspiration | 4/5 | `LiquidityAmounts` is directly portable; event shapes unambiguous. |
| Domain fit (Base chain specifically) | 5/5 | Same bytecode deployed on Base. |
| Maintenance health | 3/5 | Code is frozen but correct; no ongoing releases needed. |
| **Overall** | **4/5** | Non-negotiable reference. |
