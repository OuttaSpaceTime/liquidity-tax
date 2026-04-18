# solana-etl

**Location:** ~/Code/Misc/onchain/solana-etl
**Language:** Rust
**License:** Check repo `LICENSE` (blockchain-etl projects are typically MIT/Apache).
**Maintenance:** Owned by blockchain-etl. Current (Rust) iteration; previous Python version archived at `solana-etl-airflow`. Moderately active, infrastructure-oriented.

## Purpose
A production ETL pipeline that extracts Solana block data by slot range from an RPC node and publishes it to downstream sinks — primarily Google BigQuery, but also Pub/Sub, RabbitMQ (classic and stream), and JSON/JSONL files. Designed for data-warehouse-style "ingest the whole chain."

## Architecture
- `src/main.rs` / `src/lib.rs` — entry point, CLI, master thread.
- `src/source/json_rpc.rs`, `src/source/rest.rs` — block/slot fetchers calling `getBlock`, `getSlot`, `getMultipleAccounts` against a Solana RPC.
- `src/output/` — one module per sink (`google_pubsub.rs`, `rabbitmq_classic.rs`, `rabbitmq_stream.rs`, and JSON/JSONL via `prost-reflect`).
- `src/solana_config/` — request/response types, protobuf glue.
- Protobuf schemas drive the wire format (`prost-build`, built by `build_proto.rs`).
- Concurrency model: master thread pushes slot numbers into an async queue; long-lived worker threads pull slots, call `getBlock`, deserialize, and publish to a shared stream queue (docs/extraction.md).
- Feature flags in `Cargo.toml` select sink and timestamp format at build time (`GOOGLE_PUBSUB`, `RABBITMQ_STREAM`, `JSONL`, ...).

## Concrete value for our decoder

- **Not much, honestly.** This is block-by-slot ETL, not wallet-scoped. Our use case is "give me all transactions touching wallet X ever" — the efficient primitive for that is `getSignaturesForAddress`, which solana-etl doesn't use and isn't designed around. Running this pipeline to later filter by wallet would mean ingesting the entire Solana chain (terabytes/day) to keep the subset we want.
- **Confirming the hypothesis in the brief:** yes, it's batch ETL, not wallet-filtered. No code path here takes a wallet address as input filter.
- **Architectural inspiration — limited:**
  - The master/worker concurrent-queue pattern (`async-channel`) for slot fanout is tidy, but our workload (hundreds to low thousands of signatures per wallet) doesn't need it.
  - The feature-gated output sinks show a reasonable plugin pattern but we only need SQLite.
- **No TS bindings.** Pure Rust binary, protobuf output. Integrating with our TypeScript CLI would require running it as a subprocess and parsing its proto/JSONL output — overkill.

## Key files

- `README.md`
- `docs/extraction.md` — the concurrency model.
- `docs/getting-started.md`
- `src/source/json_rpc.rs` — how they call `getBlock`.
- `Cargo.toml` — feature matrix.

## Integration sketch

Skip. If we ever need historical bulk data beyond one wallet (e.g. training a protocol-detection classifier on many wallets), we'd pull from the BigQuery public `bigquery-public-data.crypto_solana` dataset that solana-etl populates, via the BigQuery CLI or REST API. We would not run the ETL ourselves.

## Gaps

- Everything specific to our use case: wallet-scoped querying, instruction decoding, tax classification, persistence, pricing.

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Direct reuse | 1/5 | Wrong granularity (block-level, not wallet-level). |
| Architectural inspiration | 2/5 | Concurrent slot-queue is clean but not what we need. |
| Domain fit | 1/5 | Built for data-warehousing, not tax decoding. |
| Maintenance health | 3/5 | Alive, used by blockchain-etl BigQuery feed, but not hot. |
| **Overall** | **2/5** | Useful reference only if we later want bulk chain data. |

## Top files to read

1. `README.md`
2. `docs/extraction.md`
3. `docs/getting-started.md`
4. `src/source/json_rpc.rs`
5. `Cargo.toml` (for the feature-matrix pattern)
