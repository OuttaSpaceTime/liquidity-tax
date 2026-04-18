# Claims Verification — Tax Decoder Planning vs Reference Repos

**Date:** 2026-04-18
**Method:** Spot-checked 10 highest-stakes claims from `.claude/docs/explorations/001-...md` and `.claude/docs/repo-analysis/_synthesis.md` against actual source at `/home/felix/Code/Misc/defi-tracker/onchain/`.
**Status:** No code changes. Read-only audit.

---

## Results summary

| # | Claim | Verdict |
|---|---|---|
| 1 | staketaxcsv architecture (`report_sol.py` → handlers → Koinly exporter) | ✓ Confirmed |
| 2 | staketaxcsv `handle_orca.py` has **no** Whirlpool coverage | ✓ Confirmed |
| 3 | Whirlpools SDK exposes `getPositionData`, `collectFees`, `updateFeesAndRewards` | ✓ Confirmed — but **legacy SDK is sunsetted**; see doc 04 |
| 4 | Rotki Aerodrome decoder inherits VelodromeLikeDecoder (51 lines on 569) | ⚠ Partially — inheritance correct, **paths drifted** (lookup table in doc 04) |
| 5 | Navi SDK is official TS with deposit/borrow/repay/etc. APIs | ⚠ Partially — old SDK deprecated; **new canonical is `@naviprotocol/lending` in `naviprotocol-monorepo`** (see doc 04) |
| 6 | Turbos SDK exposes read/tx-construction, no historical event parsing | ✓ Confirmed |
| 7 | Suilend Move source defines 9 event struct types | ✗ Wrong — there are **13** |
| 8 | `sui-events-indexer` can bootstrap TS types from package ID alone | ✓ Confirmed |
| 9 | `solana-tx-parser-public` Anchor version mismatch with Whirlpools | ✓ Confirmed (low risk) |
| 10 | rp2 FIFO engine in `in_out_pair.py` / `abstract_accounting_method.py` (Apache-2.0) | ⚠ Partially — license ✓, **`in_out_pair.py` does not exist** |

---

## Detail

### 1. staketaxcsv architecture — ✓ Confirmed

**Claim:** Per-chain entry point (`report_sol.py`) → per-protocol handlers → canonical row format → Koinly exporter. Column layout at `ExporterTypes.py:386-412`, export logic at `Exporter.py:942-964`.

**Evidence:**
- `report_sol.py` is the Solana entry point.
- `ExporterTypes.py:386-412` defines `KOINLY_FIELDS` exactly: Date, Sent Amount, Sent Currency, Received Amount, Received Currency, Fee Amount, Fee Currency, Net Worth Amount, Net Worth Currency, Label, Description, TxHash.
- `Exporter.py:940-964` shows label mapping (TRADE→"", INCOME→"other income", LP_DEPOSIT→"Liquidity In", LP_WITHDRAW→"Liquidity Out").
- `make_tx.py` defines the canonical `Row` schema (`sent_amount`, `sent_currency`, `received_amount`, `received_currency`, `fee`, `fee_currency`, `comment`, `txid`).

**Impact:** None. Reference is solid.

### 2. staketaxcsv Orca coverage — ✓ Confirmed (no Whirlpool)

`handle_orca.py` exports only `handle_orca_swap_v2()` — classic constant-product swaps. Zero grep hits for "whirlpool" in `staketaxcsv/sol/`. No `update_fees_and_rewards`, no `collectFees`, no position NFT handling.

**Impact:** Confirms the open-source market gap. The premise of the project stands.

### 3. Whirlpools SDK — ✓ Confirmed

`legacy-sdk/whirlpool/src/impl/position-impl.ts` exports `PositionImpl` with `collectFees()`, `collectFeesV2()`, `updateFeesAndRewards()`, `collectRewardIx()`, `decreaseLiquidityIx()`, `increaseLiquidityByTokenAmountsV2Ix()`. `PositionImpl.getData()` returns `PositionData`.

**⚠ Surprise — resolved in doc 04:** the legacy SDK is explicitly being sunsetted. New canonical is **`@orca-so/whirlpools`** (v7.x) + `@orca-so/whirlpools-core`. Key API: `fetchPositionsForOwner`, `harvestPosition` (bundles fees + rewards), `decreaseLiquidity`, `closePosition`. New SDK requires **Solana Web3.js v2**, which forces a stack decision (see doc 04 Finding 2 and doc 03 new issue [1B.0]).

### 4. Rotki Aerodrome decoder — ⚠ Partially true (paths drifted)

- Aerodrome decoder inherits `VelodromeLikeDecoder` ✓
- Aerodrome decoder is ~52 lines (claim: 51) ✓
- VelodromeLikeDecoder is 569 lines ✓
- **BUT:** actual paths are `/chain/base/modules/aerodrome/decoder.py` (not `/chain/evm/decoders/aerodrome/`) and `/chain/evm/decoding/velodrome/decoder.py` (not `/chain/evm/decoders/velodrome/`).

**Impact:** Minor — synthesis paths need fixing. No architectural impact. Rotki recently refactored toward per-chain module dirs.

### 5. Navi SDK — ⚠ Partially true + CRITICAL SURPRISE

**Claim:** Official TS SDK with deposit/borrow/repay/flash-loan/health-factor APIs.

**Reality:**
- Functions exist: `depositCoin()`, `borrowCoin()`, `repayDebt()`, `repayFlashLoan()` in `PTB/commonFunctions.ts`.
- These are **transaction builders only, not event decoders.**
- No event-parsing helpers, no historical tx reconstruction.
- **README explicitly warns:** "⚠️ This version is no longer actively maintained. New users should migrate..." to a new monorepo.

**Impact (updated after doc 04 research):** New canonical is **`@naviprotocol/lending`** from the `naviprotocol-monorepo` (stable, TS). Still signing-side only, except `getUserClaimedRewardHistory(address, page, size, market?)` which exposes paginated reward-claim history. **Strategy unchanged:** parse Move events via Sui RPC + `sui-events-indexer`. Use `getUserClaimedRewardHistory` as a cross-check for reward coverage.

### 6. Turbos SDK — ✓ Confirmed (read + builder only)

README confirms modules are `contract`, `trade`, `pool`, `position`, `account`, `math`. All examples are query/build/swap. No event listeners or parsers.

**Impact:** Same as Navi — our Sui handlers must parse Move events via RPC, not SDK.

### 7. Suilend event count — ✗ WRONG (13, not 9)

Synthesis claim of 9 event types is inaccurate. Actual Move structs found:

1. `MintEvent`
2. `RedeemEvent`
3. `DepositEvent`
4. `WithdrawEvent`
5. `BorrowEvent`
6. `RepayEvent`
7. `ForgiveEvent`
8. `LiquidateEvent`
9. `ClaimRewardEvent`
10. `InterestUpdateEvent`
11. `ReserveAssetDataEvent`
12. `ClaimStakingRewardsEvent`
13. `ObligationDataEvent`

**Impact:** POSITIVE — more coverage than planned. Handler must target all 13. Suggests the synthesis scan was shallow in this area; other event counts may be similarly under-reported.

### 8. sui-events-indexer — ✓ Confirmed

README: "Automatically: Creates TypeScript types from Move events." CLI takes `-p <package_id>` and `--network mainnet`. No Move source file required. Outputs auto-generated TS DTOs, Prisma schema, event handlers, REST API. Uses bytecode disassembly for dependency resolution.

**Impact:** Excellent bootstrapping path for Sui handlers.

### 9. Anchor version mismatch — ✓ Confirmed (low risk)

- `solana-tx-parser-public` pins `@coral-xyz/anchor: ^0.31.1`
- Whirlpools uses `@coral-xyz/anchor: ~0.32.1`
- Anchor 0.31→0.32 IDL parsing is usually compatible.
- `legacy.idl.converter.ts` exists as a documented fallback.

**Impact:** Low-medium. Smoke test early in Phase 1B. **Note:** if we adopt the new `@orca-so/whirlpools` SDK (Web3.js v2 path, recommended in doc 04), this concern becomes moot — the new SDK does not use client-side Anchor IDL parsing the same way.

### 10. rp2 FIFO engine — ⚠ Partially true

- `abstract_accounting_method.py` exists at `src/rp2/abstract_accounting_method.py` ✓
- Apache-2.0 license ✓ (porting is legal)
- **BUT:** `in_out_pair.py` does **not** exist. FIFO lot-matching is distributed across:
  - `in_transaction.py` (`InTransaction` class)
  - `out_transaction.py` (`OutTransaction` class)
  - `gain_loss.py` (`GainLoss` class)
  - `gain_loss_set.py` (`GainLossSet` class)

**Impact:** Phase 3 tax-engine port is slightly more complex than described — must understand the full class hierarchy, not a single file. Still tractable, still Apache-2.0.

---

## Biggest surprises (rank-ordered)

### 1. Navi SDK is deprecated

README explicitly directs new users to a successor monorepo. Fragments our official-SDK leverage story for Sui. Planning assumed a single canonical Navi SDK; we now need to pick between a deprecated SDK and an unvalidated replacement.

**Action:** Research the successor monorepo before Phase 1C starts. If the new monorepo exists and is stable, update references; if not, document the gap and proceed with the deprecated SDK for read-only event type discovery.

### 2. Whirlpools SDK lives under `/legacy-sdk/`

Directory naming implies successor. Not verified whether the legacy SDK is still the recommended integration point or a successor is in active development elsewhere in the monorepo.

**Action:** Check the Whirlpools monorepo root README to identify the canonical current SDK.

### 3. Rotki path conventions have changed

Synthesis references `/chain/evm/decoders/` but actual paths are `/chain/base/modules/` and `/chain/evm/decoding/`. Suggests the synthesis doc was written against an older Rotki checkout.

**Action:** Update synthesis doc with current paths when next touched. No blocker.

### 4. Suilend has 13 events, not 9

Unexpectedly good — more decoding coverage available. But the under-count implies other synthesis claims about event counts may be low. **Action:** Verify Turbos and Navi event-type counts before scoping handler work.

### 5. rp2 FIFO is distributed across 4 files

Phase 3 port estimate should be revised up. Not blocking MVP.

---

## Impact summary

- **High-confidence claims (use as-is):** 1, 2, 3 (with legacy-sdk caveat), 7 (updated count), 8, 10 (license).
- **Minor doc corrections needed:** 4 (paths), 10 (file references), 7 (count).
- **Increased risk factors requiring follow-up research:** 3 (Whirlpools legacy SDK), 5 (Navi deprecated).
- **No showstoppers** — core architecture claims check out. Proceed with planning.
