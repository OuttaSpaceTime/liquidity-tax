# raccoin

**Location:** ~/Code/Misc/onchain/raccoin
**Language:** Rust
**License:** GPL-3.0
**Maintenance:** Last commit 2026-02-09 (dependency update). Moderate activity, ~96 PRs.

## Purpose
Desktop crypto tax tool (Slint UI) with FIFO capital gains tracking, CoinMarketCap price history, and support for ~20 exchange/wallet formats. EU-focused with EUR as default fiat.

## Architecture
- **Transaction model:** `base.rs::Transaction` -- timestamp, operation (enum), description, tx_hash, blockchain, fee, value, gain. Clean struct with `incoming_outgoing()` helper
- **Operation enum:** `base.rs::Operation` -- tagged enum with 22 variants: Buy, Sell, Trade{incoming, outgoing}, Swap{incoming, outgoing}, FiatDeposit, FiatWithdrawal, Fee, Receive, Send, Income, Airdrop, Staking, Cashback, Expense, Stolen, Lost, Burn, IncomingGift, OutgoingGift, ChainSplit, Spam. Commented-out variants for Borrow, LoanRepayment, AddLiquidity, etc.
- **Amount model:** `base.rs::Amount` -- quantity (Decimal), currency (String), optional token_id. Has `effective_currency()`, `is_fiat()`, `try_add()` helpers
- **FIFO engine:** `fifo.rs` -- `LotQueue` (VecDeque of `Lot` entries) + `FIFO` struct with `CostBasisTracking` for capital gains. `Lot` tracks timestamp, tx_index, unit_price (Result to handle missing prices), remaining quantity
- **Plugin registration:** `linkme::distributed_slice` macro -- each exchange module defines a `static TransactionSource` with id, label, csv specs, detect/load functions. All sources auto-collected into `TRANSACTION_SOURCES` slice at compile time
- **CSV auto-detection:** `TransactionSource.detect_from_file()` matches CSV headers against expected patterns per source
- **Price history:** `price_history.rs` + `coinmarketcap.rs` -- CoinMarketCap API with `cmc_id()` mapping

## What to steal / reuse
- **Operation enum design** in `src/base.rs` lines 216-268: tagged enum with Amount payload per variant. Trade and Swap carry both incoming and outgoing. `incoming_outgoing()` method (line 374) returns `(Option<&Amount>, Option<&Amount>)` -- elegant pattern for our TypeScript discriminated union
- **Lot/LotQueue FIFO** in `src/fifo.rs` lines 41-100: clean Lot struct (timestamp, tx_index, unit_price as Result<Decimal, GainError>, remaining quantity) + binary-search insertion to maintain chronological order
- **TransactionSource registration** in `src/main.rs` lines 89-96 + individual modules: compile-time plugin registration via `distributed_slice`. TypeScript equivalent would be a barrel-export registry
- **Amount type** in `src/base.rs` lines 86-161: Decimal-based with currency, token_id for NFTs, `effective_currency()` for disambiguation -- good reference for our Amount type

## What to learn from (architectural inspiration)
- **Discriminated union for operations:** Rust's tagged enum maps directly to TypeScript's discriminated union pattern. Each variant carries exactly the data it needs (Trade has incoming+outgoing, Send has just amount)
- **Result-based error handling in lots:** `unit_price: Result<Decimal, GainError>` means missing-price lots still participate in FIFO but use zero cost basis, with the error preserved for reporting
- **Compile-time plugin registry:** The `linkme` distributed_slice pattern ensures no source can be forgotten. TypeScript equivalent: barrel export with explicit registration
- **EUR-first:** Default fiat is EUR, which aligns with German tax reporting needs

## Gaps for our use case
- **No DeFi support:** Operation enum has Borrow, LoanRepayment, AddLiquidity, RemoveLiquidity etc. but they're commented out. No protocol-level decoding
- **No on-chain data:** Only parses exchange CSV exports and blockchain explorer APIs (Etherscan, Esplora). No Solana RPC, no Sui indexer
- **Rust, not TypeScript:** Good patterns but nothing directly portable
- **No Koinly output:** Has CoinPanda CSV export (`coinpanda.rs`) and CryptoTaxCalculator (`ctc.rs`) but no Koinly format
- **Desktop-only:** Slint UI, not a CLI tool
- **GPL license:** Copyleft; code can't be directly incorporated

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Code reusability | 2/5 | Rust -- good patterns but requires complete reimplementation |
| Architectural inspiration | 4/5 | Operation enum, FIFO lot queue, plugin registration are excellent patterns |
| Domain fit | 2/5 | No DeFi, no Solana/Sui, but EUR-first is nice |
| Maintenance health | 3/5 | Active but low frequency |
| **Overall** | **3/5** | **Best discriminated-union Operation type design; good FIFO reference** |

## Top 3 files to read
1. `src/base.rs` -- Operation enum (line 216), Transaction struct (line 298), Amount type (line 86), GainError enum (line 60)
2. `src/fifo.rs` -- Lot struct, LotQueue with binary-search insertion, FIFO capital gains tracking
3. `src/main.rs` -- TransactionSource struct (line 89), distributed_slice plugin registration (line 147), CsvSpec header matching
