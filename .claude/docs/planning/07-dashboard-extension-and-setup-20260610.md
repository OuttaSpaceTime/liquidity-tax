# 07 — Dashboard extension + full setup checklist (2026-06-10)

**Trigger:** Felix asked to (a) finish the current scope (CLI through Phase 1D) and (b) extend the project with a Next.js dashboard: current open positions, live "tax owed right now", CSV mirror, charts, position profitability, monthly reports + yearly report. This doc records the prerequisites, the scope-change consequences, and the revised roadmap. Research basis: 9-agent sweep on 2026-06-10 (repo audit, docs 01–06 extraction, liquidity-sheets, rotki/raccoin UIs, Next.js+SQLite stack, chart libs, BMF-Schreiben 06.03.2025, live-position SDK APIs).

---

## 1. Where the project stands (verified 2026-06-10)

- `bun run check` passes (7 tests). Implemented: Drizzle schema (7 tables, 2 migrations), canonical `TaxEvent` type with type-level (type, subtype) enforcement, env validation, exhaustive Koinly label map, schema smoke tests.
- **No pipeline code exists yet** — no ingest, no DecoderRegistry, no handlers, no price fetcher, no CSV exporter, no TUI, no CLI entrypoint, no `tests/fixtures/`.
- GitHub issues: #1 `[0.1]`, #2 `[0.2]` closed; #3 `[0.3]` (DecoderRegistry) is next; #4–#12 (Phase 1A) + #13 (`[F.1]`) open. Phase 1B (5 issues), 1C (6), 1D (4) are drafted in doc 03/05 but **not filed** — doc 06's next step is the interactive walkthrough for 1B (explain → critic agents → file).
- The four "open decisions" in CLAUDE.md are stale — all were **locked** in the 2026-04-19 walkthrough (doc 05/06): Sui spike = task 1 of 1C; all historical wallets tagged active/archived; per-handler test-first with ≥3 hand-labeled real txs; Solana = Web3.js v2 (`@solana/kit` + `@orca-so/whirlpools` v7).
- Remaining CLI estimate (docs 01/03): 1A 3–4d · 1B 3–4d · 1C 4–6d · 1D 2–3d ⇒ **~12–17 days**.

## 2. Setup checklist (everything Felix must do; agent is blocked from `.env` / `config/wallets.ts`)

### 2.1 Accounts + keys (Day-1 set, from doc 03)

| # | What | Where | Env var | Blocking? |
|---|---|---|---|---|
| 1 | Helius (Solana RPC + enhanced tx), free 1M credits/mo | https://www.helius.dev | `HELIUS_API_KEY` | Yes — 1B + Solana live positions |
| 2 | Alchemy (Base RPC), free 300k calls/day | https://www.alchemy.com | `ALCHEMY_API_KEY` | Yes — 1A + Base live positions |
| 3 | CoinGecko Demo API, free 10k calls/mo | https://www.coingecko.com/en/api | `COINGECKO_API_KEY` | Yes — pricing (now needed in **EUR**, see §3.1) |
| 4 | Sui RPC: public `https://fullnode.mainnet.sui.io` OK for backfill; get a free dedicated endpoint (Shinami/BlockVision/QuickNode) before the dashboard polls live positions — public node is aggressively rate-limited and Navi/Turbos/Suilend reads are devInspect-heavy | provider of choice | `SUI_RPC_URL` | Soft now, hard for dashboard live view |
| 5 | Koinly free account — Day-1 signup; `[1A.6]`/`[1D.4]` empirically validate CSV import + `reward` label | https://www.koinly.io | — | Yes — exporter acceptance |
| 6 | `cp .env.example .env` and fill 1–4 | local | — | Yes |
| 7 | `config/wallets.ts`: **all historical** wallets (Rabby, Coinbase Wallet, Phantom, Sui), tagged `active`/`archived` per locked decision | local | — | Yes — ingest + fixtures + per-wallet FIFO |

No further accounts needed for the dashboard: verified that Alchemy + Helius + Sui RPC + CoinGecko cover live position/fee reads for all six protocols (§5). DefiLlama fallback needs no key.

### 2.2 Tax inputs Felix must provide (new — required by "tax owed right now")

1. **Marginal-rate mode:** either (simple) personal marginal rate % + church-tax flag, or (accurate) expected other taxable income for the year + filing status, so the estimator computes `ESt(income + crypto) − ESt(income)` via §32a. Stored in a non-secret config (e.g. `config/tax.ts`).
2. **Policy flag `lpDepositIsDisposal`** — BMF-Schreiben 06.03.2025 explicitly does **not** cover liquidity mining/NFTs; prevailing practitioner view: pool deposit = Tausch = disposal. Default `true` (conservative); CLMM-NFT counter-position exists. Revisit with Steuerberater.
3. **Policy flag haSUI loop** — re-stake of borrowed SUI treated as not-a-disposal (already embedded in `[1C.4]`); confirm with Steuerberater eventually.
4. **One uniform daily price convention** (source + method, e.g. CoinGecko daily close) — Rz 91 accepts Tageskurse only if applied uniformly to acquisitions AND disposals. Pick once, store per event, never mix.

### 2.3 Decisions to confirm (recommendations preselected)

| Decision | Recommendation |
|---|---|
| Where the dashboard lives | Same repo, Bun workspace: root stays the CLI package, add `apps/dashboard` (Next.js); root `package.json` exports `./db/schema`. One repo, one DB, zero duplication. |
| Dashboard runtime | Next.js App Router **on Node** (plain `next dev`; `bun install` fine, no `--bun` — Bun-runtime Next has an open segfault class as of 2026-06, and `bun:` imports can't be bundled). |
| Dashboard DB access | `drizzle-orm/better-sqlite3`, **readonly** open on the same `DB_PATH`, `busy_timeout=5000`. CLI remains sole writer + sole migration runner. WAL is exactly this topology; keep `data/` writable for `-shm`/`-wal` mapping. |
| UI kit + charts | shadcn/ui + **Recharts v3** (typed generics on `data`/`dataKey`, React 19/Next 15 native, CSS-var dark mode). Fallback if dense series choke SVG: ECharts. Tremor/visx rejected (React 18-capped). |
| Roadmap order | Finish CLI 1A→1D first; then Phase 2 = tax engine; Phase 3 = dashboard (§4). Live-position view parallelizable once keys + wallets exist. |

## 3. Scope-change consequences (what "tax owed now" pulls forward)

The dashboard is **not** just UI. Three deferred items become required:

### 3.1 EUR valuation (gap in current design)
`TaxEvent.priceUsd` and `prices.usd_price` are USD-only; German tax is EUR. Add EUR alongside USD (CoinGecko `vs_currency=eur` directly — avoids a second FX-conversion step), i.e. `prices` keyed `(asset, date)` gains a `eur_price` column (or currency-keyed layout) and events carry per-side EUR. Fold into `[1A.8]`/`[1D.1]` before backfilling so the cache isn't fetched twice.

### 3.2 Tax engine (was Phase 3 / Stage 3b — becomes Phase 2)
Rules per **BMF-Schreiben v. 06.03.2025** (replaces 10.05.2022; applies to all open cases):
- §23: disposal ≤ 1 year taxable; 1-year clock restarts on every Tausch (Rz 55); crypto↔crypto/fiat/goods all disposals (Rz 54). Gain = Erlös − Anschaffungskosten − Werbungskosten (fees) (Rz 57–60).
- **Freigrenze €1,000/yr from VZ 2024** (€600 ≤ 2023), cliff not allowance: ≥ €1,000 ⇒ fully taxable; "weniger als" ⇒ exactly €1,000.00 is taxable (Rz 53, §23 Abs. 3 S. 5).
- **Lot matching Rz 61–62: per-wallet, per-token FIFO** (Einzelbetrachtung if traceable; Vereinfachung = plain FIFO). Method locked per (wallet, token) until balance fully disposed. Own-wallet transfers move lots between pools and must be documented (Rz 103) ⇒ `transfer_links` is load-bearing for correctness, not bookkeeping.
- §22 Nr. 3 income (lending Rz 65, passive staking Rz 48, LP fees/rewards by analogy): Marktkurs at Zufluss, starts its own 1-year clock; **€256 Freigrenze** (cliff) over summed Leistungseinkünfte; §22-Nr.-3 losses ring-fenced. Rz 48a: unclaimed rewards recognized latest 31 Dec ⇒ **year-end sweep** job.
- **No 10-year extension**: Rz 63 disapplies §23 Abs. 1 S. 1 Nr. 2 S. 4 for currency tokens — holding period is always 12 months despite lending/staking.
- Rate: personal progressive §32a + Soli (+ Kirchensteuer), **not** Abgeltungsteuer (Rz 30, 53). 2026 anchors: Grundfreibetrag €12,348; 42% ~€69,879; 45% ~€277,826; Soli-Freigrenze €20,350.
- Record-keeping (Rz 89–104): erweiterte Mitwirkungspflicht for DEX/foreign platforms; per-disposal traceability; documented price source + Verbrauchsfolge per wallet; 31-Dec balances. Manual corrections acceptable if marked (matches the TUI design).

New tables: `tax_lots`, `disposals` (FIFO port from rp2 pattern), plus tax-config. Haltefrist stays parameterized (doc 01 must-decide #8).

### 3.3 Monthly vs yearly semantics (what the UI may legitimately claim)
- Monthly = **YTD running state**: realized §23 gains/losses (per-wallet FIFO), §22 income YTD, Freigrenzen status meters, holding-period watchlist (lots crossing 12 months soon).
- "Tax owed now" = estimate of year-end liability *if the year ended today* — show **both branches** of each Freigrenze cliff (under: €0; at/over: full amount), because a December trade can flip the whole year retroactively.
- Year-end only: actual Freigrenze crossing, §23 loss netting/carryover (§10d), unclaimed-reward sweep (Rz 48a), actual marginal rate.

## 4. Revised roadmap

| Phase | Content | Est. |
|---|---|---|
| **1A–1D** (unchanged, issues #3–#12 + 15 unfiled) | CLI pipeline end-to-end; fold EUR into the price cache (§3.1) | 12–17d |
| **2 — Tax engine** (new, pulled forward) | per-wallet/per-token FIFO lots + disposals, §23 + §22 buckets, Freigrenzen, §32a estimator, year-end sweep, policy flags | 3–5d |
| **3 — Dashboard** | Bun-workspace `apps/dashboard`: Next.js (Node) + better-sqlite3 readonly + shadcn/Recharts v3. Views: Overview (net worth, YTD tax estimate both-branches, Freigrenzen meters), Positions (live: entry vs current value, unclaimed fees, days-to-tax-free, APR/IL derived), Transactions (CSV mirror of `events` with Koinly labels), Monthly report, Yearly report (§23/§22 breakdown, per-asset, export). Inspiration: rotki report views, raccoin capital-gains tables, liquidity-sheets fields (entry/current/harvested, weekly+monthly rollups). | 4–6d + 2–3d live-positions slice |

Live-position reads (no new keys, verified against SDK source): Uni V3 `positions()`+simulated `collect()`; Aerodrome via LpSugar lens (+ `VotingEscrow.locked`); Orca `fetchPositionsForOwner` + `harvestPositionInstructions` quotes (`@solana/kit`); Navi `getLendingState`/`getUserAvailableLendingRewards` (devInspect); Turbos `getOwnedObjects` + `getUnclaimedFeesAndRewards`; Suilend **`@suilend/sdk` from npm** (local repo is Move-only — pin + smoke-test). Soft key-less runtime deps: Navi open-api config endpoint, Turbos S3 contract.json.

## 5. Open items / stale docs

- CLAUDE.md "Open decisions" section is outdated (all locked) — update when convenient.
- Doc 06's walkthrough pattern (explain → critic → file) still owed for 1B/1C/1D issue filing; Phase 2/3 issues from this doc need the same pass.
- `[1A.4]` non-gauge AERO receipt edge case still intentionally open.
- Steuerberater review for `lpDepositIsDisposal` + haSUI policy.
