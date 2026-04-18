# rp2

**Location:** ~/Code/Misc/onchain/rp2
**Language:** Python
**License:** Apache 2.0
**Maintenance:** Last commit 2026-01-26. Moderately active, well-tested codebase.

## Purpose
Privacy-focused crypto tax calculator implementing FIFO, LIFO, HIFO, and LOFO lot-matching across all wallets/exchanges per asset. Generates gain/loss reports. Designed to pair with DaLI (dali-rp2) as its data loader.

## Architecture
- **Entry point:** `rp2_main.py` loads configuration + input data, calls `tax_engine.compute_tax()`
- **Tax engine:** `tax_engine.py::compute_tax()` creates a set of taxable events from in/out/intra transactions, then pairs each taxable event with acquired lots via the accounting engine
- **Accounting engine:** `accounting_engine.py::AccountingEngine` manages two iterators (taxable events + acquired lots), uses an AVL tree for lot lookup, delegates lot selection to the accounting method plugin
- **Accounting method plugins:** `plugin/accounting_method/fifo.py`, `lifo.py`, `hifo.py`, `lofo.py` -- each implements `AbstractAccountingMethod` interface. FIFO is 6 lines: returns `AcquiredLotCandidatesOrder.OLDER_TO_NEWER`
- **Transaction model:** Three types: `InTransaction` (acquisition), `OutTransaction` (disposal), `IntraTransaction` (transfer). Each carries timestamp, asset, spot_price, crypto amounts, fiat amounts, fees
- **Gain/Loss output:** `GainLoss` pairs a taxable event with its matched acquired lot, computes gain as `(disposal_price - acquisition_price) * amount`
- **Country plugins:** `plugin/country/` -- US, ES, IE, JP, generic. Defines which accounting methods are allowed per jurisdiction

## What to steal / reuse
- **FIFO lot-matching algorithm** in `src/rp2/abstract_accounting_method.py` lines 191-236: `AbstractChronologicalAccountingMethod.seek_non_exhausted_acquired_lot()` -- walks acquired lots oldest-first, tracks partial amounts, advances from_index past exhausted lots for O(n) performance
- **Lot candidates abstraction** in `src/rp2/abstract_accounting_method.py` lines 84-141: `AbstractAcquiredLotCandidates` with partial amount tracking, from/to index management -- clean separation of lot state from matching logic
- **Tax engine loop** in `src/rp2/tax_engine.py` lines 96-201: the three-way comparison (taxable == acquired, taxable < acquired, taxable > acquired) that handles partial lot consumption and lot splitting
- **GainLoss model** in `src/rp2/gain_loss.py`: pairs taxable_event + acquired_lot + crypto_amount with validation logic
- **Accounting method plugin pattern** in `src/rp2/plugin/accounting_method/`: trivial plugins that only specify sort order, while the base class handles all matching complexity

## What to learn from (architectural inspiration)
- **Universal lot queue per asset:** One FIFO queue per asset across ALL wallets/exchanges. This is the Forbes-recommended approach for crypto taxes and matches German tax authority expectations
- **Separation of concerns:** Data loading (DaLI) -> Tax calculation (RP2) -> Report generation. Three independent stages with clean interfaces
- **RP2Decimal everywhere:** Custom decimal type wrapping Python Decimal to prevent floating-point errors in tax calculations. Critical for compliance
- **Pluggable accounting methods:** Adding a new method (e.g., specific-ID for German partial disposal) requires only implementing `lot_candidates_order()` or `sort_key()`
- **Year-based method switching:** `AccountingEngine` accepts `years_2_methods` dict, allowing different accounting methods per tax year

## Gaps for our use case
- **No German jurisdiction:** Country plugins exist for US, ES, IE, JP, and generic -- no Germany. Would need to implement German 1-year holding period rule for capital gains exemption under 23 EStG
- **No DeFi awareness:** Transaction types are generic (in/out/intra). No concept of LP positions, yield farming, borrow/lend, or protocol-specific events
- **Input format is ODS:** Expects data from DaLI in ODS spreadsheet format, not from on-chain sources directly
- **Python only:** Would need to port lot-matching algorithm to TypeScript
- **No Koinly output:** Generates its own report format, not Koinly-compatible CSV

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Code reusability | 3/5 | Algorithm is portable but Python-specific implementation details |
| Architectural inspiration | 5/5 | Gold-standard lot-matching architecture with pluggable methods |
| Domain fit | 2/5 | No DeFi awareness, no German jurisdiction, no Koinly output |
| Maintenance health | 3/5 | Maintained but slower cadence |
| **Overall** | **4/5** | **Phase 3 reference for FIFO lot-matching engine** |

## Top 3 files to read
1. `src/rp2/abstract_accounting_method.py` -- FIFO/LIFO/HIFO lot selection algorithm, partial lot tracking, AcquiredLotCandidates abstraction
2. `src/rp2/tax_engine.py` -- Core tax computation loop pairing taxable events with acquired lots
3. `src/rp2/accounting_engine.py` -- Engine that coordinates taxable event and acquired lot iterators with AVL tree indexing
