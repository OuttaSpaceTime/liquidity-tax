# CoinTaxman

**Location:** ~/Code/Misc/defi-tracker/onchain/CoinTaxman
**Language:** Python 3.9
**License:** AGPL-3.0 (copyleft — derivative works must also be AGPL; important constraint if lifting code)
**Maintenance:** Active (last commit 2026-03-28, "FIX matching trades must ignore none Transactions")
**Stars:** (not checked)

## Purpose
Single-author German-jurisdiction crypto tax tool. Ingests exchange CSV statements (Binance, Kraken, Coinbase, Bitpanda Pro), applies §23 EStG one-year speculation rule via FIFO, and exports an xlsx plus a WISO-compatible CSV for the German tax return.

## Architecture
- `main.py` (80 lines) — thin orchestrator: build `Book` → load statements → `Taxman.evaluate_taxation()` → `print/export_evaluation_as_excel/export_evaluation_as_wiso_csv`.
- `book.py` (1967 lines) — huge grab-bag: one `_read_<exchange>` method per exchange CSV dialect. This is the dirty ingest layer; each exchange row becomes one or more `Operation` instances.
- `transaction.py` (1022 lines) — the canonical model. `Operation` dataclass hierarchy: `Buy/Sell/Deposit/Withdrawal/Airdrop/Staking/CoinLend/Commission/CoinLendInterest/StakingInterest/Fee` plus matching `*ReportEntry` output rows (`SellReportEntry`, `BuyReportEntry`, `InterestReportEntry`, `UnrealizedSellReportEntry`, `DepositReportEntry`, `WithdrawalReportEntry`, etc.).
- `balance_queue.py` (341 lines) — abstract `BalanceQueue` with `BalanceFIFOQueue` / `BalanceLIFOQueue` implementations; tracks per-(platform, coin) lots as `BalancedOperation(op, sold)`. Has a `buffer_fee` mechanism to handle exchanges that deduct fees before the trade executes.
- `taxman.py` (1057 lines) — the §23 core. Key pieces: `_evaluate_taxation_GERMANY` (per-op dispatch), `_evaluate_sell` (the one-year rule applied per sold-coin lot), `get_buy_cost` / `get_sell_value`, `_evaluate_unrealized_sells` (year-end unrealized valuation).
- `price_data.py` (731 lines) — fetches and caches EUR spot prices from multiple APIs; sqlite-backed.
- `database.py` / `patch_database.py` — sqlite for cached prices.

Data flow: exchange CSV → `Book._read_*` → `Operation` list → `Taxman` (per-op: balance-queue mutation + FIFO pop on sells, producing `SellReportEntry` rows) → xlsx / WISO CSV.

## Concrete patterns worth stealing
- **Operation → ReportEntry duality** (`transaction.py:40` and `transaction.py:258`). Inputs are events; outputs are per-taxable-event rows. Our decoder should mirror this split: canonical ledger event vs. Koinly-exporter row.
- **Per-platform-per-coin BalanceQueue** (`balance_queue.py:48`). Each asset has its own FIFO lot queue, keyed by platform. For multi-chain this is natural — our lots will be keyed by `(chain, asset)` or possibly flattened if the user is one person across chains (German §23 is per-taxpayer, not per-platform — re-check this).
- **`is_taxable = sc.op.utc_time + relativedelta(years=1) >= op.utc_time`** (`taxman.py:281`) — the literal §23 one-year rule, expressed on a SoldCoin-granular basis. **Port this line verbatim.**
- **Deposit linking for cross-platform transfers** (`taxman.py:333+`). When a Sell draws from a Deposit, it walks the `link` to the original Withdrawal and evaluates the sale against the original buy's timestamp/cost-basis — this is essential to avoid treating inter-wallet transfers as taxable events. Our multi-chain decoder MUST do this.
- **`buffer_fee` in BalanceQueue** for out-of-order fee deductions — a real-world edge case we'll also hit on-chain (e.g. gas paid before a swap settles).
- **`_evaluate_unrealized_sells`** — year-end mark-to-market for open positions (informational, not tax-relevant in DE, but useful for reporting).

## Concrete code worth reusing
- **FIFO queue logic** (`balance_queue.py`): port directly to TypeScript. It's ~250 lines of clean, abstract-over-order logic.
- **§23 one-year check**: port verbatim.
- **Operation class hierarchy**: reference as a checklist for TrType enum, but our on-chain event set is different (add: LP add/remove, reward claim, borrow, repay, bridge in/out).
- **WISO-CSV export** (`taxman.py:972`): reference only — Felix is exporting to Koinly, not WISO. But if he ever needs ELSTER-friendly output, steal the column layout here.
- **xlsx export with per-field formatting** (`taxman.py:698`): reference — but prefer Koinly CSV first.

## Gaps / what it doesn't cover
- **Zero on-chain support**. Reads exchange CSVs only. All DeFi events (LP, lending, yield, CLMM) are absent.
- **No EVM/Solana/Sui parsing**. Felix needs this entirely himself.
- **No LP/CLMM concept**. No notion of a position, fees harvested, or impermanent loss.
- **No borrow/loan handling** — has `CoinLend/CoinLendInterest` stubs but `_evaluate_taxation_GERMANY` TODO-pass's them (see `taxman.py:387`). Aave/Suilend/Navi borrow flows will need fresh design.
- **Single-user, single-language codebase** — AGPL copyleft means we can read for inspiration freely but cannot paste into a non-AGPL-compatible project. Felix's project license needs to accommodate this if porting non-trivially.

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Code reusability | 3/5 | FIFO + §23 check portable. AGPL limits direct copy-paste into non-AGPL. Port-by-reading is fine. |
| Architectural inspiration | 4/5 | Operation/ReportEntry split and BalanceQueue pattern are clean and directly applicable. |
| Domain fit | 5/5 | German jurisdiction. §23. EUR. No other repo in this group is as aligned. |
| Maintenance health | 4/5 | Single maintainer but actively committing this month. |
| **Overall** | **4/5** | **The reference implementation for German §23 logic. Read closely, port carefully, respect AGPL.** |

## Top 3 files to read
1. `/home/felix/Code/Misc/defi-tracker/onchain/CoinTaxman/src/transaction.py` — canonical Operation + ReportEntry model
2. `/home/felix/Code/Misc/defi-tracker/onchain/CoinTaxman/src/taxman.py` — §23 FIFO evaluation, especially lines 244–382 (`_evaluate_sell`, `evaluate_sell`)
3. `/home/felix/Code/Misc/defi-tracker/onchain/CoinTaxman/src/balance_queue.py` — FIFO/LIFO lot queue
