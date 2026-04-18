# BittyTax

**Location:** ~/Code/Misc/onchain/BittyTax
**Language:** Python
**License:** AGPL-3.0
**Maintenance:** Last commit 2026-04-13 (Kraken parser update). Actively maintained.

## Purpose
UK-focused crypto tax calculator with 100+ exchange/wallet parsers, HMRC-compliant capital gains calculation (Section 104, Same Day, Bed & Breakfast rules), and comprehensive income tracking. Full pipeline from CSV import to tax report generation.

## Architecture
- **Converter layer:** `conv/bittytax_conv.py` + `conv/parsers/` -- 100+ parser modules, each a `DataParser` instance with header matching and row/all handlers. Auto-detects CSV format by matching headers
- **Parser dispatch:** `conv/dataparser.py::DataParser` -- self-registering: each parser appends itself to `DataParser.parsers` class list on instantiation. Header matching determines which parser handles a file
- **Canonical record:** `t_record.py::TransactionRecord` -- (t_type, buy, sell, fee, wallet, timestamp, note). Buy and Sell are separate objects with quantity, asset, cost/proceeds
- **Transaction splitting:** `transactions.py::TransactionHistory` splits each `TransactionRecord` into `Buy` and/or `Sell` objects, assigns fee values, handles trade fee attribution
- **Tax types enum:** `bt_types.py::TrType` -- 31 types including `LOAN`, `LOAN_REPAYMENT`, `LOAN_INTEREST`, `MARGIN_GAIN`, `MARGIN_LOSS`, `MARGIN_FEE`, `MARGIN_FEE_REBATE`
- **Tax events:** `tax_event.py` -- `TaxEventCapitalGains` (disposal with cost/proceeds/gain), `TaxEventIncome` (acquisition with amount), `TaxEventMarginTrade`
- **Tax engine:** `tax.py` -- UK-specific: Section 104 pooling, Same Day matching, 30-day Bed & Breakfast rule
- **Report output:** `report.py` -- generates PDF/Excel tax reports

## What to steal / reuse
- **Loan/borrow tax event modeling** in `src/bittytax/bt_types.py` lines 25-55: `TrType.LOAN` is an acquisition (Buy), `TrType.LOAN_REPAYMENT` is a disposal (Sell), `TrType.LOAN_INTEREST` is a disposal (Sell). This is the exact pattern needed for Aave deposit/borrow/repay
- **Buy/Sell type classification** in `src/bittytax/bt_types.py` lines 87-121: `BUY_TYPES` tuple includes LOAN alongside DEPOSIT, STAKING, INTEREST, AIRDROP. `SELL_TYPES` includes LOAN_REPAYMENT, LOAN_INTEREST alongside SPEND, WITHDRAWAL
- **TransactionRecord.to_csv()** in `src/bittytax/t_record.py` lines 163-212: 13-column export format (type, buy_quantity, buy_asset, buy_value, sell_quantity, sell_asset, sell_value, fee_quantity, fee_asset, fee_value, wallet, timestamp, note)
- **Self-registering DataParser pattern** in `src/bittytax/conv/dataparser.py` lines 96-123: each parser auto-registers by appending to class-level list. Header matching auto-detects format

## What to learn from (architectural inspiration)
- **Dual-side record model:** `TransactionRecord` always has explicit Buy side and Sell side (+ optional Fee side), rather than a single flat row. This makes trade fee attribution explicit and handles crypto-to-crypto trades cleanly
- **Comprehensive tx type taxonomy:** 31 types covering deposits, loans, margin, gifts, charity, lost coins, staking. More granular than staketaxcsv's taxonomy
- **Parser self-registration:** No central registry -- parsers register themselves on import. Clean extensibility pattern
- **Fee attribution logic:** `transactions.py` lines 42-92 -- sophisticated fee value splitting between buy/sell sides depending on trade type (fiat-to-crypto, crypto-to-fiat, crypto-to-crypto)

## Gaps for our use case
- **UK-only tax rules:** Section 104 pooling, Same Day, Bed & Breakfast rules are HMRC-specific. German 1-year holding period exemption under 23 EStG is fundamentally different
- **No on-chain DeFi parsing:** Parsers handle exchange CSVs only. One `defitaxes.py` parser exists but it imports from DeFi Taxes service, not raw on-chain data
- **No Koinly output:** Generates its own report format
- **No Solana/Sui support:** Parser ecosystem is exchange-focused (Binance, Kraken, Coinbase, etc.) with some blockchain explorers (Etherscan, Blockscout)
- **AGPL license:** Viral license may be a concern for reuse

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Code reusability | 3/5 | Loan modeling pattern and tx type taxonomy are directly useful |
| Architectural inspiration | 4/5 | Dual-side record model, self-registering parsers, fee attribution |
| Domain fit | 2/5 | UK-only rules, exchange-only parsers, no DeFi |
| Maintenance health | 5/5 | Active -- commit yesterday |
| **Overall** | **3/5** | **Best reference for loan/borrow/repay tax modeling** |

## Top 3 files to read
1. `src/bittytax/bt_types.py` -- TrType enum with LOAN, LOAN_REPAYMENT, LOAN_INTEREST; BUY_TYPES/SELL_TYPES classification
2. `src/bittytax/transactions.py` -- TransactionHistory splitting logic, fee attribution between buy/sell, Buy/Sell class definitions
3. `src/bittytax/t_record.py` -- TransactionRecord dual-side model, to_csv() output format
