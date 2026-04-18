# staketaxcsv

**Location:** ~/Code/Misc/onchain/staketaxcsv
**Language:** Python
**License:** MIT
**Maintenance:** Last commit 2026-02-13 (Waltio export feature). Actively maintained, ~388 PRs merged.

## Purpose
Multi-chain crypto tax CSV generator supporting 20+ blockchains and 25+ export formats (Koinly, CoinTracking, BittyTax, etc.). Parses on-chain transactions and emits standardized CSV rows per tax platform.

## Architecture
- **Entry point:** `report_sol.py` (per-chain report modules) fetches transactions via RPC, hands to `sol/processor.py`
- **Per-protocol handlers:** `sol/handle_orca.py`, `sol/handle_jupiter_perp.py`, `sol/handle_raydium_stake.py`, etc. Each receives a `TxInfoSol` object and produces `Row` objects
- **Canonical tx model:** `common/Exporter.py::Row` -- flat record with timestamp, tx_type, received_amount/currency, sent_amount/currency, fee/currency, exchange, wallet, txid, comment
- **Tx type enum:** `common/ExporterTypes.py` -- defines `TX_TYPE_TRADE`, `TX_TYPE_STAKING`, `TX_TYPE_LP_DEPOSIT`, `TX_TYPE_LP_WITHDRAW`, `TX_TYPE_BORROW`, `TX_TYPE_REPAY`, etc.
- **Export dispatch:** `Exporter.export_format()` switches on format string, calls format-specific method (e.g., `export_koinly_csv()`)
- **Koinly exporter:** `Exporter.export_koinly_csv()` (line 930) maps tx_types to Koinly labels, writes 12-column CSV
- **LP treatment:** Configurable via `LP_TREATMENT_TRANSFERS` / `LP_TREATMENT_OMIT` / `LP_TREATMENT_TRADES` for formats that don't natively support LP events

## What to steal / reuse
- **Koinly CSV column layout** in `src/staketaxcsv/common/ExporterTypes.py` lines 386-412: the exact 12 fields (Date, Sent Amount, Sent Currency, Received Amount, Received Currency, Fee Amount, Fee Currency, Net Worth Amount, Net Worth Currency, Label, Description, TxHash)
- **Koinly label mapping** in `src/staketaxcsv/common/Exporter.py` lines 942-964: tx_type-to-Koinly-label map (TRADE->"", STAKING->"staking", AIRDROP->"airdrop", LP_DEPOSIT->"Liquidity In", LP_WITHDRAW->"Liquidity Out", BORROW->"", REPAY->"")
- **Canonical Row model** in `src/staketaxcsv/common/Exporter.py` lines 22-39: the 14 fields that make up the universal intermediate representation
- **Tx type taxonomy** in `src/staketaxcsv/common/ExporterTypes.py` lines 76-106: the complete set of exportable and non-exportable tx types (good reference for our own event enum)
- **Orca swap handler** in `src/staketaxcsv/sol/handle_orca.py`: simple pattern for decoding Orca Swap V2 + Whirlpool swap transactions from balance changes
- **Solana tx parser** in `src/staketaxcsv/sol/parser.py`: how to extract balance_changes, transfers, and mints from raw Solana RPC data

## What to learn from (architectural inspiration)
- **Flat Row as universal IR:** All chains emit the same `Row(timestamp, tx_type, received, sent, fee, ...)` regardless of protocol complexity. This simplifies the export layer dramatically
- **tx_type prefix convention:** Non-exportable internal types use `_` prefix (`_STAKING_DELEGATE`, `_LP_STAKE`), exportable types are clean (`TRADE`, `STAKING`). Easy filtering
- **LP treatment modes:** The 3-way choice (transfers/omit/trades) for LP events per export format is a clean pattern for handling platform differences
- **Per-chain handler dispatch:** `sol/processor.py` routes by program ID to specific handlers -- same pattern we need for routing by protocol address

## Gaps for our use case
- **Orca handler is swaps only:** `handle_orca.py` handles Orca Swap V2 and recognizes the Whirlpool program ID, but only decodes simple swaps -- no CLMM position open/close, fee harvesting, or liquidity add/remove
- **No Sui support:** No chain module for Sui at all (Turbos, Navi, Suilend are absent)
- **No Base/Ethereum DeFi:** No Uniswap V3, Aerodrome, or Aave handlers
- **No German tax rules:** Export-only tool; has no concept of holding periods, FIFO matching, or jurisdiction-specific rules
- **Export-format only:** Generates CSV for other tools to consume, not a standalone tax calculator

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Code reusability | 4/5 | Koinly CSV format spec, Row model, tx type enum are directly portable |
| Architectural inspiration | 4/5 | Flat Row IR + handler dispatch + LP treatment modes |
| Domain fit | 3/5 | Solana support exists but no CLMM, no Sui, no Base |
| Maintenance health | 4/5 | Actively maintained, recent commits |
| **Overall** | **4/5** | **Primary reference for Koinly CSV output format and tx type taxonomy** |

## Top 3 files to read
1. `src/staketaxcsv/common/ExporterTypes.py` -- Koinly CSV fields (lines 386-412), all tx type constants, LP treatment modes
2. `src/staketaxcsv/common/Exporter.py` -- Row class (line 22), Koinly export logic (line 930), LP treatment routing (line 178)
3. `src/staketaxcsv/sol/processor.py` -- Solana program-ID-based handler dispatch pattern
