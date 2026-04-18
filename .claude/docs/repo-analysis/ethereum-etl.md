# ethereum-etl

**Location:** ~/Code/Misc/onchain/ethereum-etl
**Language:** Python 3 (CLI + library via `ethereumetl`)
**License:** MIT
**Maintenance:** Active (last commit 2026-01-25). Long-lived blockchain-etl project, widely used for BigQuery pipelines.

## Purpose
A batch ETL tool for exporting Ethereum-compatible chain data (blocks, transactions, logs, token transfers, traces, receipts, contracts, tokens) into CSV or JSON for warehousing. We cloned it to evaluate whether it helps with **per-wallet tx ingestion on Base**, beyond what viem + an RPC node already provide.

## What it gives us
- CLI commands (`ethereumetl export_blocks_and_transactions`, `export_token_transfers`, `export_receipts_and_logs`, `export_traces`, etc.) that walk a block range and dump normalized CSVs.
- Schemas for each export (`schemas/` + `docs/schema.md`) that are a decent reference for "what fields belong on a decoded log / trace / transfer row" if we want our SQLite schema to match BigQuery conventions.
- A `stream` command that tails the chain and emits decoded records — useful only for ongoing indexers, not historical user tax computation.
- A `filter_items` utility (`ethereumetl/cli/filter_items.py`) that takes a CSV and a Python predicate string and filters rows. **This is address filtering as a post-processing step on already-exported CSVs — not a native "give me all txs for address X" endpoint.**

## Verdict on per-wallet ingestion
**Not first-class.** ethereum-etl's model is "scan a contiguous block range; export everything; filter later." There is no `--address 0xabc` flag that tells the exporter to only fetch that address's transactions; the closest path is:

1. Export `token_transfers` or `transactions` for a (possibly wide) block range → CSV.
2. Run `filter_items` to keep rows where `from_address == user or to_address == user`.

This is slower and more bandwidth-heavy than calling `eth_getLogs` via viem with `topics[1] = pad(userAddress)` or querying an indexer like Etherscan/Basescan or a subgraph. The win-case for ethereum-etl is **bulk multi-wallet analytics against a full-chain export (or the public BigQuery dataset)** — not a single wallet.

For our decoder — a headless CLI doing one wallet at a time — viem + `getLogs` filtered by topic (or a Basescan API call) is strictly better: lower latency, no intermediate CSV, no need to manage a growing archive.

The one remaining use: if we ever want to backfill an archive for many wallets we own (e.g. offline tax reports across years), exporting Base's `token_transfers` + `logs` for the relevant block range once and then filtering locally with SQLite is a reasonable batch strategy. That's a future consideration, not an MVP need.

## How we'd use it in our decoder
Probably not at all in the MVP. Candidate uses if it becomes useful:
- Reference `schemas/` when designing our SQLite decoded-log table (column names like `address`, `topics`, `data`, `log_index`, `transaction_hash`, `block_number`, `block_timestamp`).
- Borrow the Python `trace` schema if we ever want internal-tx/ETH-transfer accounting on Base — `export_geth_traces` + `extract_geth_traces` is the reference implementation for decoding Geth `debug_traceBlock` output into flat rows. Base (OP Stack) exposes Geth traces.
- If a full Base export exists on BigQuery (it does — blockchain-etl publishes a `bigquery-public-data.crypto_base` dataset), query BigQuery directly for historical address activity rather than running ethereum-etl ourselves.

## Key files
- `~/Code/Misc/onchain/ethereum-etl/ethereumetl/cli/export_receipts_and_logs.py` — log export shape
- `~/Code/Misc/onchain/ethereum-etl/ethereumetl/cli/export_token_transfers.py` — ERC-20 transfer extraction (log decoding reference)
- `~/Code/Misc/onchain/ethereum-etl/ethereumetl/cli/filter_items.py` — post-hoc address filter (confirms it's not first-class)
- `~/Code/Misc/onchain/ethereum-etl/ethereumetl/cli/export_geth_traces.py` + `extract_geth_traces.py` — internal tx / trace extraction reference
- `~/Code/Misc/onchain/ethereum-etl/schemas/` — JSON/CSV schemas (naming conventions)
- `~/Code/Misc/onchain/ethereum-etl/docs/schema.md` — human-readable schema docs

## Gaps
- No per-address indexing; address filtering is post-hoc on exported CSVs.
- Python, not TS — ecosystem mismatch with our viem codebase.
- No protocol-specific decoding (Uniswap V3 mint/burn, Aave supply) — this is raw logs + ERC-20 transfers only.
- Streaming mode needs its own infra (Kafka/PubSub or local files + cursor).

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Direct reuse (artifacts: ABIs, TS types, schemas) | 2/5 | Schemas only, and in Python CSV form. |
| Code pattern inspiration | 3/5 | Trace/log extraction is reference-quality. |
| Domain fit (Base chain specifically) | 2/5 | Works (Base is OP-Stack, JSON-RPC compatible) but not designed for single-wallet tax use. |
| Maintenance health | 4/5 | Active. |
| **Overall** | **2/5** | Skip for MVP; revisit only if bulk historical exports become needed. |
