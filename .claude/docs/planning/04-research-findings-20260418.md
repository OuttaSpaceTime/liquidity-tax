# Research Findings — Resolving the Surprising Claims

**Date:** 2026-04-18
**Input:** 5 open questions from `02-claims-verification-20260418.md` (Navi deprecated, Whirlpools legacy-sdk, Rotki paths, Turbos/Navi event counts, Koinly label mapping).
**Method:** Web research + local clone cross-check.

---

## 1. Navi SDK migration — resolved

**Canonical SDK is now the `naviprotocol/naviprotocol-monorepo`**, publishing four scoped packages:
- `@naviprotocol/lending` (our target)
- `@naviprotocol/astros-aggregator-sdk`
- `@naviprotocol/astros-bridge-sdk`
- `@naviprotocol/wallet-client`

All TypeScript, all marked "Stable". **Still signing-side only** except `getUserClaimedRewardHistory(address, page, size, market?)` which is paginated reward-claim history.

**Impact:** Event-parsing strategy unchanged — we still parse Move events via Sui RPC + `sui-events-indexer`. Dependency should be `@naviprotocol/lending`, not `navi-sdk`. `getUserClaimedRewardHistory` is useful as a cross-check for reward-claim coverage.

**Sources:**
- https://github.com/naviprotocol/naviprotocol-monorepo (last update 2026-04-15, 72.4% TS)
- https://sdk.naviprotocol.io/lending
- https://sdk.naviprotocol.io/lending/reward

---

## 2. Whirlpools SDK — `@orca-so/whirlpools-sdk` is being sunsetted

**New canonical:** `@orca-so/whirlpools` (v7.x) — recommended for TypeScript integrators.
**Supporting:** `@orca-so/whirlpools-client` (low-level, auto-generated), `@orca-so/whirlpools-core` (Rust→WASM math).

**Key API surface (new SDK):**
- `fetchPositionsForOwner(rpc, owner)` — replaces manual enumeration
- `harvestPosition` — bundles fee + reward collection; `updateFeesAndRewards` is internal
- `decreaseLiquidity`, `closePosition`

**Caveat:** The new SDK requires **Solana Web3.js v2** / `@solana/kit`. Our planned `solana-tx-parser-public` targets Web3.js v1. This forces a stack decision:
- **Path A:** New Whirlpools SDK (v2) + migrate the tx-parsing stack to v2 equivalents.
- **Path B:** Stay on legacy Whirlpools SDK + Web3.js v1 for as long as it works; accept eventual migration.

**Upside of Path A:** The Anchor 0.31 ↔ 0.32 mismatch concern disappears — new SDK doesn't use client-side Anchor IDL parsing the same way.

**Sources:**
- https://github.com/orca-so/whirlpools (README)
- https://www.npmjs.com/package/@orca-so/whirlpools
- https://dev.orca.so/ts/functions/_orca-so_whirlpools.fetchPositionsForOwner.html
- https://dev.orca.so/SDKs/Position%20Management/Harvest/

**Recommendation:** Path A (new SDK). Legacy is sunsetted on a known timeline; better to pay the v2 cost once than to port after launch.

---

## 3. Rotki path drift — canonical lookup table

| Target | Current path |
|---|---|
| Aerodrome (Base) | `rotkehlchen/chain/base/modules/aerodrome/decoder.py` |
| Velodrome base/shared | `rotkehlchen/chain/evm/decoding/velodrome/decoder.py` |
| Velodrome (Optimism) | `rotkehlchen/chain/optimism/modules/velodrome/decoder.py` |
| Uniswap V3 shared | `rotkehlchen/chain/evm/decoding/uniswap/v3/decoder.py` |
| Uniswap V3 (Base) | `rotkehlchen/chain/base/modules/uniswap/v3/decoder.py` |
| Aave V3 shared | `rotkehlchen/chain/evm/decoding/aave/v3/decoder.py` |
| Aave V3 (Base) | `rotkehlchen/chain/base/modules/aave/v3/decoder.py` |

Pattern: shared base at `/chain/evm/decoding/<protocol>/`, per-chain overlay at `/chain/<chain>/modules/<protocol>/`.

---

## 4. Turbos / Navi event-type counts — inconclusive, use bootstrap strategy

Could not fully enumerate via web:
- Turbos: `turbos-finance/turbos-sui-move-interface` exists but source tree exploration hit 404s.
- Navi: Move source is not publicly discoverable; new monorepo exposes only TS tx-builders.

**Minimum known Navi events** (from old navi-sdk constants): `DepositEvent`, `BorrowEvent`, `RepayEvent`, `WithdrawEvent`, `LiquidateEvent`, `ClaimRewardEvent`, `FlashLoanEvent`. Definitive list requires on-chain introspection.

**Recommendation:** Don't quote specific event counts in the plan. Treat **Phase 1C task 1 as: run `sui-events-indexer -p <package_id>` against Turbos / Navi / Suilend package IDs and capture the generated TS types as canonical.**

---

## 5. Koinly CSV label mapping — resolved

**Koinly custom-CSV accepted tags:**
- *Incoming:* airdrop, fork, mining, **reward**, income, lending interest, cashback, salary, fee refund, loan, margin loan, stake, realized gain
- *Outgoing:* loan repayment, margin repayment, stake, realized gain
- *Neutral:* swap
- *Auto-applied (not settable via CSV):* Liquidity In, Liquidity Out

**Mapping decisions:**
- `lp_fee` (harvested LP trading fees) → **`reward`**
- `lp_reward` (LP incentives, AERO gauge emissions, etc.) → **`reward`**
- `other income` is semantically equivalent in Koinly's tax engine; staketaxcsv uses it for generic `INCOME` rows. Either works.

**Germany tax note:** Koinly treats `reward` and `stake` identically for German tax purposes — both are income at receipt with 1-year holding period (post-May 2022 change from 10-year). Operationally neutral.

**Phase 1D empirical test:** import a 5-row CSV with `reward`, `other income`, and empty labels against a fresh Koinly sandbox; compare the tax classification Koinly applies.

**Sources:**
- https://support.koinly.io/en/articles/9489976-how-to-create-a-custom-csv-file-with-your-data
- https://support.koinly.io/en/articles/9490054-liquidity-providing-lping-liquidity-in-out
- https://koinly.io/blog/defi-tax-germany/

---

## Consolidated plan changes (applied to 02 and 03)

1. **02 — Finding 3 (Whirlpools):** Upgrade to resolved. New canonical = `@orca-so/whirlpools` (v7.x). Legacy sunsetted. Web3.js v2 requirement adds a stack decision.
2. **02 — Finding 4 (Rotki):** Replace "paths drifted" with the lookup table above.
3. **02 — Finding 5 (Navi):** Canonical = `@naviprotocol/lending` from `naviprotocol-monorepo`. Strategy unchanged (parse events via RPC); add `getUserClaimedRewardHistory` as cross-check.
4. **02 — Finding 7 (Suilend events):** Keep the 13-struct list; mark Turbos/Navi as indexer-bootstrap.
5. **02 — Finding 9 (Anchor mismatch):** Becomes moot if we adopt the new Whirlpools SDK (Web3.js v2 path).
6. **03 — Orca handler issue:** Target `@orca-so/whirlpools` + `@orca-so/whirlpools-core`; API = `fetchPositionsForOwner`, `harvestPosition`, `decreaseLiquidity`, `closePosition`.
7. **03 — Navi handler issue:** Depend on `@naviprotocol/lending`; add `getUserClaimedRewardHistory` cross-check as subtask.
8. **03 — Koinly export issue:** Default label for `lp_fee` and `lp_reward` = `reward`; Phase 1D sandbox empirical test comparing `reward` vs `other income` vs empty.
9. **03 — NEW issue:** Solana stack decision — Web3.js v1 (legacy Whirlpools SDK + `solana-tx-parser-public` as planned) vs Web3.js v2 (new Whirlpools SDK + migrated tx parser). **Recommend v2.**
