# aave-utilities

**Location:** ~/Code/Misc/onchain/aave-utilities
**Language:** TypeScript (Lerna monorepo: `@aave/math-utils`, `@aave/contract-helpers`, `@aave/contract-types`)
**License:** MIT
**Maintenance:** **DEPRECATED** per the README ("Refer to aave-sdk and Aave Docs for latest integration endpoints"). Most recent publish commit 2026-01-26. Still functional against deployed V3; Aave SDK v4 is the forward path.

## Purpose
The official TypeScript SDK for reading Aave V2/V3 state and building transactions. We cloned it to answer: can we feed it a wallet + reserves and get back clean, formatted position state — skipping most of the Aave decoding work?

## What it gives us — the big question, answered
**Yes, substantially.** The "Data Methods" path is exactly the shortcut we hoped for:

1. `UiPoolDataProvider` (`@aave/contract-helpers`) wraps the on-chain `UiPoolDataProviderV3` view. Calling `getReservesHumanized({ lendingPoolAddressProvider })` returns every reserve's config, price, rates, liquidity/borrow indexes. Calling `getUserReservesHumanized({ lendingPoolAddressProvider, user })` returns that user's scaled aToken / variableDebt / stableDebt balances per reserve. **One RPC call each, for every reserve the wallet touches.**
2. `UiIncentiveDataProvider` returns reserve-level emission APRs and user-claimable reward amounts.
3. `formatReserves` / `formatReservesAndIncentives` (`@aave/math-utils`) accrue indexes to `currentTimestamp` and produce human-readable reserve data.
4. `formatUserSummary` / `formatUserSummaryAndIncentives` combine the above with user reserves and produce **the full position state**: `totalLiquidityUSD`, `totalCollateralUSD`, `totalBorrowsUSD`, `healthFactor`, `availableBorrowsUSD`, `netWorthUSD`, per-reserve `underlyingBalance`/`underlyingBalanceUSD`/`variableBorrows`/`variableBorrowsUSD`, and `claimableRewards` dictionary.

**For point-in-time balance snapshots this completely eliminates Aave-specific decoding.** We still need historical events (supply/withdraw/borrow/repay/liquidation) to build tax lots — see Gaps — but "what does the wallet hold in Aave right now (or at block N)?" is a solved problem.

A caveat: this package depends on **ethers v5** (explicitly incompatible with v6). Our decoder is built on viem. We have two options:
- Run a thin ethers v5 provider just to serve this SDK. Pay a few extra deps, get `formatUserSummary` for free.
- Re-implement `formatReserves` / `formatUserSummary` on viem — but the math is non-trivial (ray math, per-reserve index accrual, eMode, isolation mode, health factor). The README's existence is evidence this is worth not re-doing.

Recommendation: run ethers v5 **alongside** viem for the Aave handler specifically. Isolate it behind a `aave/positions.ts` module so the rest of the codebase stays viem-only.

## How we'd use it in our decoder
```ts
// pseudo-code
import { UiPoolDataProvider, UiIncentiveDataProvider, ChainId } from '@aave/contract-helpers';
import { formatUserSummaryAndIncentives } from '@aave/math-utils';
import * as markets from '@bgd-labs/aave-address-book';
import { ethers } from 'ethers';

const provider = new ethers.providers.JsonRpcProvider(BASE_RPC);
const pdp = new UiPoolDataProvider({
  uiPoolDataProviderAddress: markets.AaveV3Base.UI_POOL_DATA_PROVIDER,
  provider,
  chainId: ChainId.base,
});
const reserves = await pdp.getReservesHumanized({ lendingPoolAddressProvider: markets.AaveV3Base.POOL_ADDRESSES_PROVIDER });
const userReserves = await pdp.getUserReservesHumanized({ lendingPoolAddressProvider: markets.AaveV3Base.POOL_ADDRESSES_PROVIDER, user: wallet });
// + incentives via UiIncentiveDataProvider
const summary = formatUserSummaryAndIncentives({ ...reserves.baseCurrencyData, reserves: formattedReserves, userReserves: userReserves.userReserves, userEmodeCategoryId, reserveIncentives, userIncentives, currentTimestamp: Math.floor(Date.now()/1000) });
// `summary` is our "Aave position" row — done.
```

For **historical** tax events we still pull `Supply`/`Withdraw`/`Borrow`/`Repay`/`LiquidationCall`/`FlashLoan` logs from the `Pool` contract via viem (see `aave-v3-core`), and `Transfer`/`Mint`/`Burn` on the aToken for interest accrual reconstruction — that piece is not in this SDK.

## Key files
- `~/Code/Misc/onchain/aave-utilities/packages/math-utils/src/formatters/reserve/index.ts` — `formatReserves`, `formatReservesAndIncentives`
- `~/Code/Misc/onchain/aave-utilities/packages/math-utils/src/formatters/user/index.ts` — `formatUserSummary`, `formatUserSummaryAndIncentives`
- `~/Code/Misc/onchain/aave-utilities/packages/math-utils/src/formatters/user/generate-raw-user-summary.ts` — health factor / totals math
- `~/Code/Misc/onchain/aave-utilities/packages/math-utils/src/formatters/user/format-user-reserve.ts` — per-reserve position formatting
- `~/Code/Misc/onchain/aave-utilities/packages/math-utils/src/pool-math.ts` — ray-math helpers, scaled-balance conversion
- `~/Code/Misc/onchain/aave-utilities/packages/contract-helpers/src/v3-UiPoolDataProvider-contract/index.ts` — `UiPoolDataProvider` class (the entrypoint)
- `~/Code/Misc/onchain/aave-utilities/packages/contract-helpers/src/v3-UiIncentiveDataProvider-contract/` — incentives companion
- `~/Code/Misc/onchain/aave-utilities/packages/math-utils/src/formatters/incentive/` — incentive formatters (claimable income)

## Gaps
- **Deprecated upstream**; Aave SDK v4 is the future. We should expect to migrate later.
- **ethers v5 lock-in** — forces a second provider lib alongside viem.
- **No historical event decoding** — this is strictly a "current state at block X" SDK. Every supply/withdraw/borrow/repay as a taxable event we still decode ourselves.
- `ChainId.base` must be present — if not, pass the numeric chain id `8453`.
- Does not compute cost basis / realized P&L — that's decoder logic on top of the balance snapshots.
- Reward emissions are point-in-time; historical reward accruals between two blocks require two snapshots diffed.

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Direct reuse (artifacts: ABIs, TS types, schemas) | 5/5 | Typechain'd ABIs + formatter functions directly importable. |
| Code pattern inspiration | 5/5 | Canonical implementations of Aave math. |
| Domain fit (Base chain specifically) | 5/5 | Base is supported via `@bgd-labs/aave-address-book`. |
| Maintenance health | 2/5 | Officially deprecated; works but end-of-life. |
| **Overall** | **4/5** | Huge shortcut; accept the ethers v5 and deprecation costs. |
