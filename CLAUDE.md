# CLAUDE.md — liquidity-tax

DeFi tax-decoder CLI. **Planning phase — no code yet.** Code will live in this directory once Phase 0 starts.

## What this is

Headless TypeScript CLI that ingests on-chain transactions from Base (EVM), Solana, and Sui; decodes them through per-protocol handlers (Uniswap V3, Aerodrome, Aave V3, Orca Whirlpool, Turbos, Navi, Suilend); persists to local SQLite; exports a Koinly-compatible CSV for German §23 tax filing. Solo-use, no UI, no server.

## Sibling repos under `~/Code/Misc/defi-tracker/`

- **`liquidity-sheets/`** — existing Google Sheets automation for LP position tracking. Separate workstream, no runtime coupling.
- **`onchain/`** — 24+ cloned reference repos (read-only). Absolute path: `/home/felix/Code/Misc/defi-tracker/onchain/<repo>/`.

## Documentation (read in order before any work)

1. `.claude/docs/explorations/001-tax-decoder-research-20260411.md` — full exploration. Final recommendation: headless TS CLI with per-protocol handlers + SQLite + Koinly CSV export (Option 1 wins). Options 2 (Rotki hybrid) and 3 (pure firehose) considered and rejected/promoted to fallback layer.
2. `.claude/docs/repo-analysis/_overview.md` — map of the 24 analyzed reference repos.
3. `.claude/docs/repo-analysis/_synthesis.md` — consensus patterns across mature tools, canonical `TaxEvent` TypeScript type, recommended pipeline stages, build order, what must be built from scratch (CLMM position lifecycle, Sui handlers, haSUI loop detection, cross-chain transfer linking).
4. `.claude/docs/repo-analysis/_notes-{evm,solana,sui,tax-engines,rotki}.md` — per-area consolidated notes.
5. `.claude/docs/repo-analysis/<repo>.md` — per-repo deep dives (rotki, staketaxcsv, whirlpools, navi-sdk, turbos-clmm-sdk, suilend, aave-v3-core, sui-events-indexer, solana-tx-parser-public, rp2, dali-rp2, CoinTaxman, BittyTax, perfi, raccoin, weaverfi, etc.).
6. `.claude/docs/planning/01-architecture-critique-20260418.md` — architecture audit: verdict, top 5 gaps, must-decide-before-coding list, estimates reality check.
7. `.claude/docs/planning/02-claims-verification-20260418.md` — 10 planning-doc claims verified against actual source in `onchain/`. Path drift and deprecations called out.
8. `.claude/docs/planning/03-accounts-and-initial-issues-20260418.md` — API-key checklist, 19-issue draft Phase 0→1D, open questions with recommendations.
9. `.claude/docs/planning/04-research-findings-20260418.md` — resolved the surprises: new canonical Navi SDK = `@naviprotocol/lending` (from `naviprotocol-monorepo`); new canonical Whirlpools SDK = `@orca-so/whirlpools` (v7, requires Solana Web3.js v2); Rotki path lookup table; Koinly label for `lp_fee`/`lp_reward` = `reward`.

## Key decisions already made

- **Language/stack:** TypeScript end-to-end + SQLite as source of truth + viem (Base) + new `@orca-so/whirlpools` SDK (Solana, Web3.js v2 path recommended) + `@naviprotocol/lending` + `turbos-clmm-sdk` + Suilend Move-source-derived types.
- **Export target:** Koinly-compatible CSV. No tax engine in MVP (Phase 3 deferred). Column layout lifted from `staketaxcsv/common/ExporterTypes.py:386-412`.
- **Pattern:** Three-phase dispatch (address-specific → generic → post-decode aggregation), rotki-style. Per-protocol handlers register against a central `DecoderRegistry`.
- **Canonical event:** `TaxEvent` with `(type, subtype)` matrix (~150 valid pairs), dual-amount model (sent + received), `positionId` for CLMM lifecycle, `flags[]` for non-destructive annotation.
- **Fallback:** unclassified txs → SQLite `unclassified` table → Ink/Inquirer TUI for manual labeling.

## Open decisions (blocking issue creation)

1. **Sui spike timing** — before Phase 1A as go/no-go, or as task 1 of Phase 1C?
2. **Wallet addresses** — hardcode all historical (Rabby/Coinbase/Phantom) or active only?
3. **Test-first granularity** — per-handler fixtures (≥3 real txs before code) or per-phase bundle?
4. **Solana stack** — Web3.js v1 (legacy Orca SDK + `solana-tx-parser-public`) vs v2 (new Orca SDK, recommended in doc 04). `[1B.0]` in doc 03.

Questions 1, 5 (repo location) already answered — sibling repos under `defi-tracker/`; Koinly label default = `reward`.

## Reference repo paths

Canonical absolute path: `/home/felix/Code/Misc/defi-tracker/onchain/<repo-name>/`. Some older docs may say `/home/felix/Code/Misc/onchain/...` (historical — repos moved 2026-04-18).

Key repos to know:
- `onchain/whirlpools/ts-sdk/` — NEW Orca SDK (Web3.js v2). `onchain/whirlpools/legacy-sdk/` — the sunsetted one.
- `onchain/naviprotocol-monorepo/` — NEW canonical Navi SDK. `onchain/navi-sdk/` — deprecated.
- `onchain/kit/` — Solana Kit (Web3.js v2).
- `onchain/turbos-sui-move-interface/` — Turbos Move source for event discovery.
- `onchain/rotki/` — three-phase dispatch reference + Aerodrome/Velodrome inheritance pattern.
- `onchain/staketaxcsv/` — Koinly CSV column layout + handler dispatch pattern.
- `onchain/sui-events-indexer/` — bootstrap TS event types from Sui package IDs.

## Global rule reminder

Per `~/.claude/CLAUDE.md`: test-first. For any non-trivial change (and especially bug fixes), write a failing test first, then fix. For this project, the test corpus is hand-labeled real on-chain txs under `tests/fixtures/`, not synthetic mocks.
