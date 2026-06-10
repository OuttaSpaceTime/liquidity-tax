# CLAUDE.md — liquidity-tax

DeFi tax-decoder CLI. **Implementation in progress** (Phase 0 done; pipeline build started 2026-06-10 on branch `implement/pipeline`).

## What this is

Headless TypeScript CLI that ingests on-chain transactions from Base (EVM), Solana, and Sui; decodes them through per-protocol handlers (Uniswap V3, Aerodrome incl. vfat/Sickle proxies, Aave V3, Orca Whirlpool, Turbos, Navi, Suilend); persists to local SQLite; computes German §23/§22 tax reports. Solo-use. A Next.js dashboard extension is planned (see `.claude/docs/planning/07-dashboard-extension-and-setup-20260610.md`).

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
- **Export target (changed 2026-06-10):** Koinly CSV export **dropped** per Felix — we generate our own reports instead (German §23/§22 engine + dashboard, doc 07). GH issues #6/#10 are obsolete in their CSV form. `config/koinly-labels.ts` stays as a label vocabulary. Reference for own reports: `liquidity-sheets/tax-report-2025/` (working Python FIFO engine + Blockpit CSV pipeline).
- **Pattern:** Three-phase dispatch (address-specific → generic → post-decode aggregation), rotki-style. Per-protocol handlers register against a central `DecoderRegistry`.
- **Canonical event:** `TaxEvent` with `(type, subtype)` matrix (~150 valid pairs), dual-amount model (sent + received), `positionId` for CLMM lifecycle, `flags[]` for non-destructive annotation.
- **Fallback:** unclassified txs → SQLite `unclassified` table → Ink/Inquirer TUI for manual labeling.

## Decisions — all locked (docs 05/06, do not re-litigate)

1. **Sui spike** = task 1 of Phase 1C. 2. **Wallets** = all historical, tagged active/archived. 3. **Test-first** = per handler, ≥3 hand-labeled real txs, failing test before handler code. 4. **Solana** = Web3.js v2 (`@solana/kit` + `@orca-so/whirlpools` v7). 5. Repo = sibling `liquidity-tax/`. 6. LP-deposit tax policy default = **basis carry-forward (not a disposal)**, matching Felix's filed 2025 report (`liquidity-sheets/tax-report-2025/`); configurable flag, see doc 07 §2.2.

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

## Project baseline

Runtime: **Bun**. Run TypeScript files directly with `bun <file.ts>`.

Key dependencies (see `package.json`):
- `drizzle-orm` + `drizzle-kit` — ORM, query builder, migration generator, Drizzle Studio.
- `zod` — env and config validation.
- ESLint + Prettier — lint and format. Tests run via `bun test` (Bun's built-in test runner).

Database: SQLite at `data/liquidity-tax.db` (overridable via `DB_PATH` env var). Driver: Bun's built-in `bun:sqlite` — no native module compilation required.

## Verification

Single gate command — run before every commit:

    bun run check   # tsc --noEmit && eslint . && bun test

After any `db/schema.ts` change:

    bun run db:generate   # regenerate migration SQL from schema
    bun run db:migrate    # apply to local SQLite

Full fresh-setup (clone to working DB):

    bun install
    cp .env.example .env   # fill in API keys
    bun run db:migrate
    bun run check          # must pass before any implementation work

## Privacy guard

**Never read `.env`, `config/wallets.ts`, or `config/wallets.staged.ts`.** Blocked at the permission layer via `.claude/settings.json` (`Read`, `Edit`, `Write`, and `Bash` deny entries). These files are write-once by humans; agents interact with their contents only through runtime indirection:

- `.env` — API keys (Helius, Alchemy, CoinGecko, Sui RPC). Gitignored. Bun auto-loads it; code uses `env`/`requireEnv()` from `src/config/env.ts`. Never access `process.env` for keys elsewhere, never echo/log key values.
- `config/wallets.ts` (canonical) / `config/wallets.staged.ts` (pending merge) — real wallet addresses. Both gitignored and untracked. Code loads them at runtime via the wallets loader (`src/config/`), which validates the `Array<{chain, address, label, status}>` contract with zod. Refer to wallets by **label or chain** in prompts, logs, and commit messages — never paste raw addresses.
- The SQLite DB and `tests/fixtures/` necessarily contain on-chain data (addresses, tx hashes). DB is gitignored; fixtures are committed to this **private** repo only.
