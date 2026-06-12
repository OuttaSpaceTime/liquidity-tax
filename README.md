# liquidity-tax

Headless TypeScript CLI that ingests on-chain transactions from Base (EVM), Solana, and Sui; decodes them through per-protocol handlers; persists to local SQLite; and feeds our own German §23/§22 tax reports (Koinly CSV export was dropped 2026-06-10 — see CLAUDE.md).

## Quickstart

```sh
bun install
cp .env.example .env   # fill in API keys
bun run db:migrate
bun run check          # must pass before any implementation work
```

## Pipeline commands

Run via `bun run cli <command>` (or `bun src/cli.ts <command>`):

| Command | Description |
|---|---|
| `ingest --chain <base\|solana\|sui> [--label <l>]` | Fetch raw txs for configured wallets into `raw_txs` (idempotent) |
| `decode [--chain <chain>]` | Three-phase decode over `raw_txs` → upsert `events`, queue `unclassified`, rebuild `positions` (idempotent) |
| `link [--dry-run]` | Match own-wallet `transfer:send`/`receive` pairs (self-transfers + cross-chain bridges) → `transfer_links` |
| `prices backfill [--max-calls <n>]` | Fetch missing daily EUR+USD closes (CoinGecko, DefiLlama fallback) |
| `prices import-eur-cache [path]` | Seed prices from the liquidity-sheets EUR cache (saves API quota) |
| `status` | Row counts per table and chain |

## Scripts

| Command | Description |
|---|---|
| `bun run check` | Full gate: `tsc --noEmit && eslint . && bun test` |
| `bun test` | Run test suite |
| `bun run lint` | ESLint only |
| `bun run build` | Type-check only (`tsc --noEmit`) |
| `bun run cli` | The pipeline CLI (see above) |
| `bun run db:generate` | Regenerate migration SQL from `db/schema.ts` |
| `bun run db:migrate` | Apply pending migrations to local SQLite |
| `bun run db:studio` | Open Drizzle Studio (local DB browser) |

## Re-decode after a handler change

`raw_txs` is the source of truth — raw transaction data is never deleted, and `events` are always derived from raws (no `ON DELETE CASCADE` in either direction). `decode` re-runs the three-phase decoder over **all** stored raws unconditionally and upserts on the natural key `(chain, tx_hash, log_index, emission_seq)`, so iterating on classification logic never needs a re-fetch:

1. Update the handler (bump its `version` when the emission semantics change — the value is recorded on each event row for provenance).
2. Re-run `bun src/cli.ts decode [--chain <chain>]`. Stale event rows the new decode no longer emits are deleted (their `transfer_links` go with them); surviving linker tags are re-applied; positions are rebuilt.

Txs no handler can fully classify land in the `unclassified` table (manual-labeling queue) instead of being silently partially decoded.
