# uni-v3-position-tracker

**Location:** ~/Code/Misc/onchain/uni-v3-position-tracker
**Language:** TypeScript (Node CLI, single-file `index.ts`)
**License:** Not declared in package.json; LICENSE file present
**Maintenance:** Dormant (last commit 2021-07-21). A two-script prototype, not a maintained library.

## Purpose
A reference prototype that pulls a single Uniswap V3 NFT position's historical state from The Graph's hosted Uniswap V3 subgraph and writes it to CSV. We cloned it as a worked example of subgraph-based fee math for V3 positions.

## What it gives us
- A complete GraphQL query shape against the Uniswap V3 subgraph for a position (token0/token1, decimals, daily priceUSD, `liquidity`, `feeGrowthInside{0,1}LastX128`, `collectedFees{0,1}`, pool `feeGrowthGlobal{0,1}X128`, pool `tick`, `sqrtPrice`, tickLower/tickUpper `feeGrowthOutside{0,1}X128`).
- An implementation of the Uniswap V3 unclaimed-fee formula (`calculateFee`) using `feeGrowthGlobal - feeGrowthOutsideLower - feeGrowthOutsideUpper - feeGrowthInsideLast) * liquidity / 2^128` — correct when in range; the out-of-range branches in the script are implemented identically and are buggy.
- Usage patterns for `@uniswap/v3-sdk` `Position` and `Pool` to recover token amounts from liquidity.
- An example of historical snapshotting via `block: { number }` subgraph arguments stepped by block-gap.

## How we'd use it in our decoder
Read-only reference. We copy the GraphQL query verbatim as the basis for a `positionSnapshot(tokenId, block)` subgraph call, and reuse `calculateFee` as the Uni V3 unclaimed-fee formula — but rewrite the branches correctly (out-of-range fees are a fixed quantity: if current tick > tickUpper, subtract `feeGrowthOutsideUpper`; if below, `feeGrowthOutsideLower`; see Uniswap V3 whitepaper §6.3). We do not adopt the hardcoded ETH-price pool lookup or the `Math.round(BigNumber.toNumber())` patterns — those lose precision.

## Key files
- `~/Code/Misc/onchain/uni-v3-position-tracker/index.ts` — everything lives here:
  - L11-96 `getData` — orchestration
  - L120-138 `calculateFee` — Uni V3 unclaimed-fee math
  - L140-203 `getPositionInfo` — canonical subgraph query (reuse this shape)
  - L228-255 `getEthPrice` — USDC/WETH pool price (don't copy; too fragile)
  - L257-272 `getDataRange` — block-stepped historical loop
- `~/Code/Misc/onchain/uni-v3-position-tracker/package.json` — deps include `@uniswap/v3-sdk`, `@uniswap/sdk-core`, `@urql/core`

## Gaps
- Only one `tokenId` at a time; no wallet-level discovery (we must enumerate NFTs owned by wallet ourselves via `NonfungiblePositionManager.balanceOf` / `tokenOfOwnerByIndex`, or subgraph `positions(where: {owner})`).
- Hardcoded mainnet subgraph URL; we must swap in the Base subgraph endpoint.
- Does not model `IncreaseLiquidity` / `DecreaseLiquidity` / `Collect` events at all — it snapshots position state, it does not compute per-tx tax lots.
- `calculateFee` has buggy branch logic for out-of-range positions (all three branches subtract both outside values).
- Uses `BigNumber.toNumber()` via `Math.round` which truncates precision for Q64.96 `sqrtPrice` / uint128 `liquidity` — unacceptable for tax math.
- No decimals-aware formatting beyond `1e{decimals}`; no USD valuation at transaction time, only daily close.

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Direct reuse (artifacts: ABIs, TS types, schemas) | 2/5 | We copy the GraphQL query text and the fee formula; no packaged artifacts. |
| Code pattern inspiration | 3/5 | Good worked example; shows shape, but precision-broken. |
| Domain fit (Base chain specifically) | 2/5 | Targets Ethereum mainnet subgraph by address; Base subgraph URL must be swapped. |
| Maintenance health | 1/5 | Dormant since 2021, no issues addressed. |
| **Overall** | **2/5** | Useful as a reference snippet, not as a dependency. |
