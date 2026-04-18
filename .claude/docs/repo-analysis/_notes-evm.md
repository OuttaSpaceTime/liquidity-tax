# EVM-side architecture notes

Cross-cutting takeaways from reviewing uni-v3-position-tracker, v3-periphery, v3-subgraph, aave-v3-core, aave-v3-periphery, aave-utilities, ethereum-etl.

- **viem vs subgraph is not either/or — use both, as a layered strategy.** Subgraphs (Uniswap V3 hosted subgraph, Aerodrome equivalent) give us pre-indexed Mint/Burn/Collect/Swap events with derived USD values; viem+RPC gives us point-in-time state reads and events the subgraph doesn't index. MVP plan: subgraph-first for Uniswap-like LP events (one query per wallet), viem for Aave (no useful public subgraph) and for verification/backfill.

- **aave-utilities is a substantial shortcut for Aave position state, but not for Aave history.** `UiPoolDataProvider.getUserReservesHumanized` + `formatUserSummaryAndIncentives` returns the full current portfolio (balances, health factor, claimable rewards) in two RPC calls. We still decode Pool events ourselves for taxable-event timelines — the SDK has no historical layer. Accept an ethers v5 dep for this; isolate it in one module.

- **Aave becomes maybe 60-70% "free" via aave-utilities.** State snapshots, ray-math, index accrual, reserve formatting, eMode/isolation handling, health factor — all done. What's left: (a) enumerating historical Supply/Withdraw/Borrow/Repay/LiquidationCall/FlashLoan events, (b) per-event USD valuation at event timestamp, (c) cost basis / realized P&L, (d) interest income recognition from scaled-balance deltas across time.

- **Uniswap V3 tax is about three events on NonfungiblePositionManager.** `IncreaseLiquidity`, `DecreaseLiquidity`, `Collect`. Everything else derives from these + `positions(tokenId)` view + pool `sqrtPriceX96`. `v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol` is the canonical source. Aerodrome slipstream is a fork with the same event layout → same decoder, different address.

- **v3-subgraph ships ABIs we can consume directly.** `~/Code/Misc/onchain/v3-subgraph/abis/NonfungiblePositionManager.json`, `pool.json`, `factory.json`. Drop straight into viem `parseAbi`/ABI imports, skip the Hardhat compile step entirely.

- **Fee math for V3 unclaimed fees is well-trodden but easy to get wrong.** The formula `(feeGrowthGlobal − feeGrowthOutsideLower − feeGrowthOutsideUpper − feeGrowthInsideLast) × liquidity / 2^128` only applies when in range; out-of-range cases need different outside-value subtraction. The uni-v3-position-tracker implementation has buggy branches — we should port from the Uniswap V3 whitepaper §6.3 or from `v3-core/contracts/libraries/Tick.sol` directly, not copy the tracker's `calculateFee`.

- **Don't do precision-losing `BigNumber → Math.round → Number`.** Q64.96 `sqrtPriceX96` and uint128 `liquidity` must stay bigint. Use viem's native `bigint` throughout. The reference prototypes (uni-v3-position-tracker) corrupt precision via `.toNumber()`; don't copy that pattern.

- **ethereum-etl is not useful for single-wallet ingestion.** Its model is "export block range → filter CSV." viem `getLogs` topic-filtered by user address is strictly better for our CLI. Only revisit if we need bulk multi-wallet/multi-year historical dumps.

- **What we still write ourselves:**
  - Historical tx enumeration per wallet (viem `getLogs` with topic filters per protocol).
  - USD valuation at event timestamp (CoinGecko/Chainlink at block, or subgraph-derived USD — decision per event).
  - Cost-basis engine (FIFO/LIFO/spec-id lot tracking) — entirely our logic.
  - Reconciliation/idempotency in SQLite (hashes of (txHash, logIndex) as primary keys).
  - Per-protocol "transaction classifier" that takes a tx + its logs and outputs semantic actions (add-liquidity, remove-liquidity, collect-fees, swap, supply, withdraw, etc.). No shipped library does this the way we need.

- **Address books are a no-brainer dep.** `@bgd-labs/aave-address-book` for Aave V3 Base; `@uniswap/sdk-core` constants for Uniswap V3 Base; Aerodrome slipstream addresses we track ourselves (their repo or docs).
