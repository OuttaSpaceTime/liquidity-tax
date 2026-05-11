# liquidity-tax

Headless TypeScript CLI that ingests on-chain transactions from Base (EVM), Solana, and Sui; decodes them through per-protocol handlers; persists to local SQLite; exports a Koinly-compatible CSV for German §23 tax filing.

## Quickstart

```sh
bun install
cp .env.example .env   # fill in API keys
bun run db:migrate
bun run check          # must pass before any implementation work
```

## Scripts

| Command | Description |
|---|---|
| `bun run check` | Full gate: `tsc --noEmit && eslint . && bun test` |
| `bun test` | Run test suite |
| `bun run lint` | ESLint only |
| `bun run build` | Type-check only (`tsc --noEmit`) |
| `bun run db:generate` | Regenerate migration SQL from `db/schema.ts` |
| `bun run db:migrate` | Apply pending migrations to local SQLite |
| `bun run db:studio` | Open Drizzle Studio (local DB browser) |

## Re-decode a contract

`raw_txs` is the source of truth — raw transaction data is never deleted. When a handler is updated or a new protocol is added, bump `handler_version` in the relevant decoder. Any `events` rows whose `handler_version` is lower than the current version become eligible for re-decode on the next ingest run.

There is no `ON DELETE CASCADE` between `raw_txs` and `events` — events are always derived from raws, never the other way around. To force a full re-decode for a protocol:

1. Update the handler and bump `handler_version` in the decoder registry.
2. Delete the corresponding `events` rows (or mark them stale).
3. Re-run `bun src/ingest.ts` — the pipeline will re-decode from the stored raws.

This means you can safely iterate on classification logic without re-fetching from the chain.
