# Cross-Repo Analysis: Tax Engine Patterns

## Canonical Event Schemas

- **staketaxcsv** uses a flat `Row` with (timestamp, tx_type, received_amount/currency, sent_amount/currency, fee/currency). Simplest model -- works well for export but loses structure for tax calculation.
- **rp2** splits into three transaction types: `InTransaction` (acquisition), `OutTransaction` (disposal), `IntraTransaction` (transfer). Each carries both crypto and fiat amounts + spot price. Most rigorous for tax math.
- **BittyTax** uses a dual-side `TransactionRecord` (buy_side, sell_side, fee_side) with 31 TrType variants. Richest taxonomy especially for loans/margin.
- **raccoin** uses a Rust tagged enum `Operation` with 22+ variants, each carrying an `Amount(quantity, currency)`. Trade/Swap carry both incoming and outgoing. Cleanest discriminated-union design.
- **perfi** has a 3-stage model: raw chain tx -> `TxLedger` (individual token movement) -> `TxLogical` (classified DeFi event with 17 types). Best pipeline separation.

## Dispatch Patterns

- **staketaxcsv:** Program-ID-based routing in `processor.py` -- if/elif chain matching Solana program IDs to handler functions. Simple but not extensible.
- **dali-rp2:** INI config section names are Python module paths, loaded via `import_module()`. Most dynamic/extensible plugin system.
- **BittyTax:** Self-registering parsers -- each `DataParser` appends itself to a class-level list on instantiation. CSV header matching selects the parser. Elegant auto-detection.
- **raccoin:** Compile-time distributed slice (`linkme` crate) -- each module registers a `TransactionSource` static. Zero-overhead plugin registry.

## Export Formats

- **staketaxcsv** is the Koinly reference: 12 columns (Date, Sent Amount/Currency, Received Amount/Currency, Fee Amount/Currency, Net Worth Amount/Currency, Label, Description, TxHash). Label values: "staking", "airdrop", "cost", "other income", "Liquidity In", "Liquidity Out", "realized gain", or empty.
- **rp2** outputs ODS spreadsheets with gain/loss reports -- not directly Koinly-compatible.
- **BittyTax** generates PDF/Excel UK tax reports -- not Koinly-compatible.
- **raccoin** has CoinPanda and CryptoTaxCalculator CSV exporters but no Koinly.
- **perfi** generates IRS Form 8949 -- US-specific.

## FIFO Lot Matching

- **rp2** has the most sophisticated implementation: pluggable accounting methods (FIFO/LIFO/HIFO/LOFO), partial lot consumption with `AcquiredLotCandidates` abstraction, year-based method switching, AVL tree for lot lookup. O(n) for FIFO.
- **raccoin** has a clean `LotQueue` (VecDeque) with binary-search insertion for chronological ordering. Simpler but effective. Handles missing prices via `Result<Decimal, GainError>`.
- **perfi** has FIFO in `costbasis.py` but tightly coupled to SQLite and Ethereum.

## Loan/Borrow/Repay Modeling

- **BittyTax** is the clear reference: `LOAN` = acquisition (Buy), `LOAN_REPAYMENT` = disposal (Sell), `LOAN_INTEREST` = disposal (Sell). Clean mapping to buy/sell accounting.
- **staketaxcsv** has `TX_TYPE_BORROW` and `TX_TYPE_REPAY` but maps both to empty Koinly labels (transfers, not taxable events).
- **perfi** has `borrow`, `repay`, `deposit`, `withdraw` in TX_LOGICAL_TYPE but minimal implementation.
- **raccoin** has Borrow/LoanRepayment commented out in the Operation enum -- not yet implemented.

## Universal Gaps

- No repo implements German 23 EStG (1-year holding period capital gains exemption). rp2 has country plugins but Germany is missing.
- No repo handles CLMM (concentrated liquidity) position tracking -- impermanent loss, range-bound positions, fee accrual within tick ranges.
- No repo supports Sui chain at all. Solana support exists only in staketaxcsv (basic swaps, no Whirlpool CLMM).
- No repo handles Aerodrome or Turbos protocols.

## Key Takeaway for Our Implementation

Combine: staketaxcsv's Koinly CSV format + perfi's 3-stage pipeline architecture + rp2's FIFO lot-matching algorithm + raccoin's discriminated-union Operation type + BittyTax's loan/borrow modeling. Build per-protocol handlers (Orca Whirlpools, Uniswap V3, Aerodrome, Aave, Turbos, Navi, Suilend) as the novel contribution none of these repos provide.
