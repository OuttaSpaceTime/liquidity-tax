# turbos-clmm-sdk

**Location:** ~/Code/Misc/onchain/turbos-clmm-sdk
**Language:** TypeScript (pnpm, tsup build, targets Node >=18)
**License:** MIT
**Maintenance:** Actively maintained. Latest release v3.6.4 tagged 2025-08-12; CHANGELOG shows steady semver cadence through 2025 (3.5.x in June, 3.6.x through August). Published to npm as `turbos-clmm-sdk` with a peerDependency on `@mysten/sui ^1.0.0`.

## Purpose
Official Turbos Finance SDK for building and executing Sui CLMM (concentrated-liquidity market-maker) transactions and reading current pool / position state. It is the Sui analogue of Orca's whirlpools SDK: the same surface area (pools, positions, swaps, fee/reward quoting) but delivered as plain state-read helpers plus `Transaction` builders for PTB composition.

## Architecture
Single `TurbosSdk` root (`src/sdk.ts`) instantiated with a `Network` and optional `SuiClient`. It wires up seven modules exposed as fields:

- `pool` (`lib/pool.ts`, ~1040 lines) — the heavy-hitter: `createPool`, `addLiquidity` / `addLiquidityByAmountObject`, `removeLiquidity` (+`WithReturn`), `collectFee`, `collectReward`, plus the raw PTB target strings (`position_manager::increase_liquidity`, `::decrease_liquidity`, `::decrease_liquidity_with_return_`).
- `position` (`lib/position.ts`) — thin subclass of `NFT` exposing `getPositionFields`, `getPositionFieldsByPositionId`, `getPositionTick`, `getPositionLiquidityUSD`, `getUnclaimedFees`, `getUnclaimedRewards`, `getUnclaimedFeesAndRewards`, `burn`.
- `nft` (`lib/nft.ts`) — underlying NFT helpers; `position` inherits from it (older API).
- `contract` (`Config`, `Fee[]`), `trade` (`computeSwapResult`, `swap`), `coin`, `account`, `vault`, `math`.
- `utils/collect-fees-quote.ts` and `utils/collect-rewards-quote.ts` — the pure fee-accrual math (U128 `feeGrowthInside` deltas × liquidity >> 64). These are valuable as a *reference implementation* of CLMM fee math for Turbos specifically.

## Concrete value for our decoder
- **Can import as npm dep:** Yes, directly. `pnpm add turbos-clmm-sdk @mysten/sui`. Peer dep is `@mysten/sui ^1.0.0`, which we'd already be using.
- **Position-state reads (analogue of Orca `getPositionData`):** Yes — `sdk.position.getPositionFieldsByPositionId(positionId)` returns the on-chain `PositionField` (liquidity, tick_lower_index, tick_upper_index, fee_growth_inside_{a,b}, tokens_owed_{a,b}, reward entries). Combined with `sdk.pool.getPool(poolId)` and `sdk.position.getPositionTick()` you get everything needed to compute current underlying amounts + unclaimed fees + unclaimed rewards in USD via `getUnclaimedFeesAndRewards({ poolId, position, getPrice })`.
- **Event-decoding story for historical txs:** **Zero.** Grepped the entire `src/` — no `queryEvents`, no event type names, no event parsers. The SDK is strictly (a) build a PTB or (b) read current object state. For reconstructing historical deposits, withdrawals, fee claims, and reward claims (which is what a tax decoder needs), we are on our own with `suiClient.queryTransactionBlocks` / `queryEvents` filtered by the Turbos package ID. The SDK does give us the package ID and the exact Move call target strings (`position_manager::increase_liquidity`, `::decrease_liquidity`, `pool::collect_fee`, etc.) to match against.

## Key files
- `src/sdk.ts` — root SDK entry (50 lines).
- `src/lib/pool.ts` — all liquidity/fee/reward PTB builders + Move call target strings.
- `src/lib/position.ts` + `src/lib/nft.ts` — position state reads and USD valuation helpers.
- `src/utils/collect-fees-quote.ts` + `src/utils/collect-rewards-quote.ts` — reference fee/reward math.
- `src/lib/math.ts` — tick ↔ sqrt-price ↔ liquidity math utilities.
- `CHANGELOG.md` — confirms active maintenance cadence.

## Integration sketch
For Turbos in our decoder:

1. **Ingest:** `suiClient.queryTransactionBlocks({ filter: { InputObject: walletAddress }, options: { showEvents: true, showEffects: true, showInput: true } })` paginated by cursor. This gives every tx the wallet touched.
2. **Filter:** keep txs whose `transaction.data.transaction.transactions[*].MoveCall.package === TURBOS_PACKAGE_ID`.
3. **Classify:** match `module::function` against a hardcoded map — `position_manager::mint` → OpenPosition, `::increase_liquidity` → AddLiquidity, `::decrease_liquidity{,_with_return_}` → RemoveLiquidity, `position_manager::collect_fee` + `::collect_reward` → HarvestFees / HarvestRewards, `::burn` → ClosePosition.
4. **Decode amounts:** read the `events` array on each tx. Turbos emits events on liquidity/fee ops; we pair the Move-call classification with event payloads (or with `balanceChanges` in the tx effects — which Sui computes for free and is the easiest amount source).
5. **Value:** for any *current-state* snapshot (so we can reconcile closed-out positions), call `sdk.position.getPositionFieldsByPositionId(positionId)` + `sdk.position.getUnclaimedFeesAndRewards(...)` with our price oracle.

Flow: wallet → `queryTransactionBlocks` → Move-call classifier → per-event amount extraction → position ledger → (optional) SDK snapshot for reconciliation.

## Gaps
- No event-type registry shipped in the SDK — we'll have to enumerate Turbos event structs ourselves (either by walking the on-chain package with `suiClient.getNormalizedMoveModulesByPackage` or by inspection with `sui-events-indexer`).
- No historical fee/reward attribution (i.e. "how much of this harvest was fees vs rewards, in USD, at tx time"). We need a price oracle at historical timestamps.
- No `getAllPositionsForOwner` helper — we have to enumerate Turbos position NFTs via the wallet's owned objects with the Turbos NFT type tag.
- No ABI / IDL — Sui doesn't have one; we rely on Move source or normalized module metadata for struct shapes.

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Direct reuse | 4/5 | Importable npm dep; immediately useful for *state snapshots* and *tick/fee math*. |
| Architectural inspiration | 3/5 | Clean "one SDK, many modules, each a thin wrapper over `SuiClient` + PTB builders" pattern worth mirroring for our handler layer. |
| Domain fit | 4/5 | Covers exactly the Turbos surface we care about (positions, fees, rewards). |
| Maintenance health | 5/5 | Regular releases through Aug 2025, official. |
| **Overall** | **4/5** | Best-case scenario for Turbos: a live SDK we can import, but historical-event reconstruction is still fully on us. |

## Top files to read
- `src/sdk.ts`
- `src/lib/pool.ts`
- `src/lib/position.ts`
- `src/utils/collect-fees-quote.ts`
- `CHANGELOG.md`
