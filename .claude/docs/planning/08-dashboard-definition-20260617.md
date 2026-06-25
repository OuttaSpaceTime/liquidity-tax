# 08 — Dashboard definition (Next.js + React) — 2026-06-17

**Trigger:** Felix asked to *define* a Next.js/React dashboard showing **current positions, last positions, last actions, etc.** This doc is the concrete, schema-grounded specification for that dashboard. It builds on the locked stack/scope decisions in [doc 07](./07-dashboard-extension-and-setup-20260610.md) and does **not** re-litigate them.

**Method:** 5-way design fan-out (IA, data-access, components, live-reads, gaps) + a completeness critic, each grounded in the real schema (`db/schema.ts`), the canonical `TaxEvent` type (`src/types/event.ts`), the position reducer (`src/positions/tracker.ts`), and the existing read repos. The critic's findings are folded in throughout (see [§13](#13-reconciliations-corrections-folded-in-from-the-design-critique)).

> **Implementation status (2026-06-17): M1 built and verified.** `apps/dashboard` exists and runs (`bun run dashboard`); `next build` passes, all routes render against the live DB (2366 events / 129 positions), root `bun run check` stays green (430 tests, incl. 12 new shared-query tests). Two deviations from the plan, both flagged in `apps/dashboard/README.md`: **(1) runtime = Bun** (`bun --bun`), not Node — chosen to reuse the `bun:sqlite` repos + `loadWallets()` privacy indirection directly (Bun-Next was verified stable here); **(2) styling = hand-written CSS**, not shadcn/Tailwind+Recharts — a presentation-only layer for a clean build, swappable later. M2 (live on-chain reads) and M3 (tax reports, Phase-2 engine) remain deferred exactly as scoped below.

Two realities shape every decision below — state them once, they recur everywhere:

- **The Phase-2 tax engine does not exist yet.** No `tax_lots` / `disposals` tables, no FIFO, no realized §23 gains, no §22 buckets, no Freigrenzen, no §32a estimator (doc 07 §3.2). **Every view that would show a realized gain or "tax owed" renders a labelled placeholder, never a fabricated number.**
- **`positions.state_json` holds cumulative TOKEN amounts, not value.** `principal = deposited − withdrawn` per asset (and it can go negative — IL/price drift). It is not EUR and not the current on-chain balance. "Current value" / "unclaimed fees right now" need either a live on-chain SDK read (doc 07 §4) or `amount × daily-close` from the `prices` table — both clearly fenced in the UI.

---

## 1. What this defines (scope)

A **read-only** Next.js (App Router, Node runtime) dashboard in a Bun workspace at `apps/dashboard`, reading the same SQLite DB the CLI writes. It surfaces:

| The ask | View | Built from |
|---|---|---|
| **current positions** | `/positions` (Current) | `positions WHERE closed_at IS NULL` + `state_json` |
| **last positions** | `/positions/closed` (Last/Closed) | `positions WHERE closed_at IS NOT NULL` ordered `closed_at DESC` |
| **last actions** | `/activity` (Activity feed) | `events ORDER BY timestamp DESC` |
| *…etc.* | `/` Overview, `/positions/[id]` detail, `/transactions`, `/reports/{monthly,yearly}` | as below |

The three named views are **fully buildable today** (plus one new read query each). The tax-report views are **Phase-2-gated stubs** so the information architecture is complete and ready to fill.

---

## 2. Stack & topology (locked in doc 07 §2.3 — recap)

- **Location:** same repo, Bun workspace. Root stays the CLI package; add `apps/dashboard` (Next.js). Root package exports `./db/schema`.
- **Runtime:** Next.js App Router on **Node** (`next dev`, *not* `--bun`; `bun:` imports can't be bundled and Bun-runtime Next has an open segfault class as of 2026-06).
- **DB access:** `drizzle-orm/better-sqlite3`, opened **readonly** on `DB_PATH`, `busy_timeout=5000`. The CLI is the **sole writer and sole migration runner**. This is exactly the WAL two-process topology.
- **UI:** shadcn/ui + Recharts v3 (React 19 / Next 15, CSS-var dark mode). ECharts is the locked fallback if dense series choke SVG.
- **Roadmap slot:** Phase 3 in doc 07 (after the CLI and the Phase-2 tax engine). Live-position reads are a parallelizable slice once keys + wallets exist.

---

## 3. Workspace wiring (concrete)

Root `package.json` today has **no** `workspaces` and **no** `exports` field — both must be added. Package name is **`liquidity-tax`** (unscoped — the import specifier is `liquidity-tax/...`, *not* `@liquidity-tax/...`).

```jsonc
// root package.json — additions
{
  "name": "liquidity-tax",
  "workspaces": ["apps/*"],
  "exports": {
    "./db/schema": "./db/schema.ts",
    "./prices":    "./src/prices/index.ts",     // utcDateOf, getPrice, repo helpers
    "./positions": "./src/positions/index.ts",  // listPositions, positionState, parsePositionId
    "./events":    "./src/db/repos/events.ts",
    "./linker":    "./src/linker/index.ts",
    "./assets":    "./src/linker/assets.ts"      // canonicalAsset (decimals source — §4c)
  }
}
```

- `apps/dashboard` imports schema as `import { positions, events, prices } from 'liquidity-tax/db/schema'`. Exporting `.ts` works because the CLI ships as source under Bun; Next on Node transpiles the workspace package via `transpilePackages: ['liquidity-tax']` in `next.config.ts` (also set `serverExternalPackages: ['better-sqlite3']` — native module, don't bundle).
- `apps/dashboard/tsconfig.json` extends the root tsconfig and adds the Next plugin.
- **`Db` type caveat:** the existing repos in `src/db/repos/*`, `src/positions/repo.ts`, `src/prices/repo.ts` are typed against the **`bun:sqlite`** `Db` alias (`src/db/client.ts`). The query-builder code is driver-agnostic, but the *type* differs from the dashboard's `better-sqlite3` handle. To call them from the dashboard, **widen the `db` parameter to the structural Drizzle type** (or export a driver-neutral `Db` type). Do this when adding the new shared queries in §5 — it's a one-line type widening per repo, no behavior change.

---

## 4. Data-access layer

### 4a. The readonly handle — `apps/dashboard/lib/db.ts`

```ts
import 'server-only';                                 // hard-fail if imported into a client bundle
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from 'liquidity-tax/db/schema';

const path = process.env.DB_PATH ?? 'data/liquidity-tax.db';   // same default as src/config/env.ts
const sqlite = new Database(path, { readonly: true, fileMustExist: true });
sqlite.pragma('busy_timeout = 5000');                 // wait out the CLI's short (≤200-row) write txns
// Do NOT set journal_mode here — WAL is set persistently by the CLI's migrate step;
// setting it from a readonly handle throws.
export const db = drizzle(sqlite, { schema });
export type DashboardDb = typeof db;
```

One module-level connection, reused across requests (better-sqlite3 is synchronous and connection-cheap). In Next dev, guard against hot-reload handle leaks with a `globalThis` singleton. Keep `data/` writable on disk so SQLite can map the `-wal`/`-shm` sidecars even from a readonly handle. **The dashboard issues zero writes, ever** — no mutation Server Actions touch the DB, and live reads (§10) persist nothing.

### 4b. Server Components vs Route Handlers — the split

| Concern | Mechanism | Why |
|---|---|---|
| All DB reads for initial render (positions, events, prices, rollups) | **Server Components** (default), calling query fns directly | Synchronous reads complete in microseconds; no client round-trip, no API layer. |
| Client-triggered **refetch** after the user ran the CLI in another terminal | **Server Action** + `router.refresh()` (or `revalidatePath`) | The DB only changes when the CLI runs; the dashboard can't observe that without a manual nudge. |
| **Live on-chain reads** (current value, unclaimed fees) | **Route Handler** `app/api/positions/live/…` with `cache: 'no-store'` | Slow, failable, key-dependent — must stay off the render path (§10). |

**Caching:** DB-backed pages are static-ish — `export const revalidate = 60`, wrap query fns in `react.cache()` for per-request dedup, and add an explicit **Refresh** button (`router.refresh()`). A **freshness chip** (last ingest = `MAX(raw_txs.fetched_at)`, last event = `MAX(events.timestamp)`) tells the user how stale the readonly WAL view is. Live Route Handlers are dynamic (`no-store`).

### 4c. Decoding & serialization contract

- **bigint blob columns** (`events.sent_amount` / `received_amount`, `mode:'bigint'`) → JS `bigint`. **React Server Components cannot serialize `bigint`** across the server→client boundary. **Convention: stringify every bigint at the query boundary** via a DTO mapper (`lib/serialize.ts → toEventDTO`); raw `bigint` never reaches a Client Component or a Route Handler `Response`. (`state_json` totals are already decimal **strings** — `AssetTotals` — so they're JSON-safe.)
- **JSON columns** (`price_usd_json`, `flags_json`, `state_json`) are auto-parsed by Drizzle `mode:'json'` — no manual `JSON.parse`. Always read `state_json` through `positionState(row)` to recover the typed `PositionState` (the column is declared `Record<string, unknown>`).
- **Token decimals** — the single source of truth is **`canonicalAsset(chain, asset)` from `src/linker/assets.ts`** (returns `{ symbol, decimals }`). **Do not create a new decimals map.** Caveat: that registry is deliberately scoped to assets Felix has held/bridged, so it is **not exhaustive** for every asset that may appear in `events`/`positions`. When a lookup misses, `<AssetAmount>` renders the raw integer with a "raw" badge rather than guessing. If misses are common in practice, **extend `REGISTRY` in `src/linker/assets.ts`** (shared with the CLI) — never fork a dashboard-local copy.

```ts
// apps/dashboard/lib/format.ts
export function formatTokenAmount(amount: bigint | string, decimals: number, maxFrac = 6): string;
// decimals from canonicalAsset(chain, asset)?.decimals; undefined ⇒ raw integer + "raw" badge.
```

### 4d. EUR valuation helper

`prices` already carries `eur_price` (nullable). German tax is EUR (doc 07 §3.1). Valuation = `amount(scaled) × eur_price` on the event's **UTC calendar day**, using the *existing* date convention so the dashboard matches what the Phase-2 engine will compute:

```ts
import { utcDateOf } from 'liquidity-tax/prices';   // existing: unix(s) → 'YYYY-MM-DD' (UTC)

// apps/dashboard/lib/valuation.ts
export function valueLegEur(
  raw: bigint | null, asset: string | null, timestamp: number, decimals: number,
  priceLookup: (asset: string, date: string) => PriceRow | undefined,
): { eur: number | null; missing: boolean };
// raw==null||asset==null → {null,false}; px?.eurPrice==null → {null, missing:true} (price not yet backfilled);
// else { Number(raw)/10**decimals * px.eurPrice, false }.
```

- Build the `priceLookup` closure from the **batched** `getPricesForPairs` (§5) over the distinct `(asset, utcDateOf(ts))` pairs in the rows — one query, in-memory lookups, no N+1.
- `eur_price` is **nullable**: surface a "price pending" chip, never render `€0`. Common until the CLI's EUR backfill (doc 07 §3.1) has run.
- `Number(raw)/10**decimals` is fine for **display only**. Anything feeding a tax figure stays in integer/decimal math — but that's the Phase-2 engine's job, not the dashboard's.

---

## 5. New read queries (consolidated — authoritative list)

Legend: **[EXISTS]** reuse as-is · **[ADD-repo]** add to `src/…` (CLI + dashboard share) · **[ADD-dash]** dashboard-local presentation shape.

| Function | Status | Location | Table / index |
|---|---|---|---|
| `listPositions(db,{chain?,wallet?,openOnly?})` | [EXISTS] | `src/positions/repo.ts` | positions |
| `getPosition`, `positionState` | [EXISTS] | `src/positions/repo.ts` | positions PK |
| `getEventsByTx`, `countEventsByChain` | [EXISTS] | `src/db/repos/events.ts` | events_uq prefix / group-by |
| `getPrice(asset,date)` | [EXISTS] | `src/prices/repo.ts` | prices PK |
| `linkedEventIds`, `listLinksForAssetWallet` | [EXISTS] | `src/linker/repo.ts` | transfer_links |
| **`recentActivity(db, opts)`** | **[ADD-repo]** | `src/db/repos/events.ts` | events_by_wallet (filtered) / scan+sort (global) |
| **`getEventsByPosition(db, positionId)`** | **[ADD-repo]** | `src/db/repos/events.ts` | events_by_position |
| **extend `ListPositionsOptions`** → `listClosedPositions` | **[ADD-repo]** | `src/positions/repo.ts` | positions (`closed_at IS NOT NULL`, `closed_at DESC`) |
| **`getPositionDetail(db, positionId)`** | **[ADD-repo]** | `src/positions/repo.ts` | positions PK + events_by_position |
| **`getPricesForPairs(db, pairs)`** | **[ADD-repo]** | `src/prices/repo.ts` | prices PK (batched) |
| **`getLatestPrices(db, assets)`** | **[ADD-repo]** | `src/prices/repo.ts` | prices (latest date per asset) |
| `overviewRollup(db)` | [ADD-dash] | `apps/dashboard/lib/queries/overview.ts` | composes the above |
| `linksForEventIds(db, ids)` | [ADD-repo, MVP-optional] | `src/linker/repo.ts` | transfer_links_by_out/in_event |

**Unified signatures** (one name each — the design fan-out proposed several; these are canonical):

```ts
// src/db/repos/events.ts
export function recentActivity(db, opts: {
  wallet?: string; chain?: Chain; type?: TaxEventType; positionId?: string;
  cursor?: { timestamp: number; id: number } | null;   // keyset, NOT offset
  limit: number;
}): EventRow[];
// WHERE (filters) ORDER BY timestamp DESC, id DESC, predicate (timestamp,id) < (cursor) for paging.
// `id` (surrogate autoincrement) is the stable tiebreak — a `before:timestamp` alone can't disambiguate
// events sharing a timestamp. Rides events_by_wallet when `wallet` is set.

export function getEventsByPosition(db, positionId: string): EventRow[];
// WHERE position_id = ? ORDER BY timestamp, tx_hash, log_index, emission_seq
// (canonical comparePositionEvents order, so the timeline matches the reducer's view). Uses events_by_position.

// src/positions/repo.ts — extend the existing options object (keeps ONE listPositions)
export interface ListPositionsOptions {
  chain?: string; wallet?: string;
  openOnly?: boolean;
  closedOnly?: boolean;                       // NEW: closed_at IS NOT NULL
  limit?: number;                             // NEW
  orderBy?: 'opened' | 'closed_desc';         // NEW: closed view wants most-recently-closed first
}
export function getPositionDetail(db, positionId): { position: PositionRow; events: EventRow[] } | undefined;

// src/prices/repo.ts — batched, avoid per-row N+1
export function getPricesForPairs(db, pairs: ReadonlyArray<{ asset: string; date: string }>): Map<string, PriceRow>;
export function getLatestPrices(db, assets: readonly string[]): Map<string, PriceRow>;
```

**Index note (carry into the UI):** `events` is indexed only by `events_by_wallet(wallet, timestamp)` and `events_by_position(position_id)` — **there is no timestamp-only index**. A *wallet-scoped* activity feed rides the index; the **global cross-wallet feed is a full scan + sort**. That's fine at solo scale (thousands of rows). If it ever isn't, the fix is a **CLI-owned migration** (`events(timestamp)` or `events(timestamp, id)`) — never a dashboard write.

---

## 6. Information architecture — route tree & navigation

```
apps/dashboard/app/
  layout.tsx              # shell: sidebar + topbar (chain/wallet filter, freshness chip, theme toggle)
  page.tsx                # "/"                       Overview        — "where do I stand right now?"
  loading.tsx · error.tsx # skeletons + error boundary (SQLITE_BUSY surfaced here)
  positions/
    layout.tsx            #   tabs: [ Current | Closed ] + shared filter bar
    page.tsx              # "/positions"              CURRENT positions (closed_at IS NULL)
    closed/page.tsx       # "/positions/closed"       LAST positions (closed_at NOT NULL, desc)
    [positionId]/
      page.tsx            # "/positions/:id"          Position detail (lifecycle timeline)
      not-found.tsx
  activity/page.tsx       # "/activity"               LAST actions (events feed, desc, filtered)
  transactions/page.tsx   # "/transactions"           per-tx event mirror (audit view)
  reports/
    monthly/page.tsx      # "/reports/monthly"        Monthly report   [Phase-2 gated]
    yearly/page.tsx       # "/reports/yearly"         Yearly report    [Phase-2 gated]
  api/positions/live/
    route.ts              # GET all open positions, live-merged          (M2 slice)
    [positionId]/route.ts # GET one position, ?refresh=1 bypasses cache   (M2 slice)
```

Sidebar = the views above (Reports group badged "β tax — Phase 2"). **All filter state lives in the URL `searchParams`** (`?chain=base&wallet=<label>&type=…&cursor=…`) so it's server-readable, persistent across navigation, and linkable. Wallet filter values are **labels**; label→address resolution happens only inside server-only query adapters (privacy).

---

## 7. The three named views (in depth)

### 7.1 Current Positions — `/positions`

`listPositions(db, { openOnly: true, chain?, wallet? })` → group in-app by **chain → protocol → wallet-label**, sort within group by `opened_at ASC` (oldest first = closest to tax-free). Every card field comes from `PositionState` or `positions` columns — nothing invented:

| Card field | Source |
|---|---|
| Position id (short), chain, protocol, wallet | `position_id` (via `parsePositionId`), `chain`/`protocol`/`wallet`→label badges |
| Principal per asset | `state.principal` (may be **negative** — show with sign) |
| Fees / rewards collected | `state.feesCollected` / `state.rewardsCollected` |
| Age · days-until-tax-free | `now − opened_at` · `opened_at + 365d − now` *(approx — see caveat)* |
| Status warnings | `state.warnings[]` → pills (`inferred_open`, `duplicate_close`, `wallet_changed`, …) |
| `inferredOpen` | amber "partial history" badge — economics may be understated |
| est. value @ close (EUR) | `Σ state.principal[asset] × getPrice(asset, today).eur_price` *(caveat below)* |
| live value · unclaimed fees | **live read (M2)**; "—" until enabled |

> **Caveats (must be labelled in the UI):**
> - **days-until-tax-free is a position-open approximation.** The §23 1-year clock restarts on every Tausch (Rz 55); the per-lot-accurate clock is Phase-2. Label it "approx".
> - **est. value @ close is not P/L and not mark-to-market.** It's `principal × today's close`. Because `principal` can be **negative per asset** (net-of-withdrawals residual / IL), the EUR sum is only meaningful when all assets are positive; otherwise show per-asset signed principal and suppress the single rollup (label: "net deposited−withdrawn at today's close").

```
/positions   [Current] Closed        chain ◇all  protocol ◇all  wallet ◇all
─────────────────────────────────────────────────────────────────────────
BASE › uniswap_v3 › "rabby-main"                                    3 open
┌────────────────────────────┐ ┌────────────────────────────┐
│ uniswap_v3 · #84217   [base]│ │ uniswap_v3 · #84931   [base]│
│ ⚠ inferred_open             │ │                             │
│ Principal  1.42 WETH        │ │ Principal  12,400 USDC      │
│            3,910 USDC       │ │            0.00 cbBTC       │
│ Fees   0.03 WETH · 88 USDC  │ │ Fees   210 USDC             │
│ Age 214d · tax-free in 151d*│ │ Age 33d · tax-free in 332d* │
│ est @close  €11,204 †       │ │ est @close  €11,980 †       │
│ live value  — (off)         │ │ live value  — (off)         │
└────────────────────────────┘ └────────────────────────────┘
* approx (per-lot §23 clock = Phase 2)   † principal×today's close; not P/L
```

### 7.2 Last Positions — `/positions/closed`

`listPositions(db, { closedOnly: true, orderBy: 'closed_desc', limit })` (new options). Token-term economics; **realized §23 gain is Phase-2** → placeholder cell.

| Column | Source |
|---|---|
| Position · chain · protocol · wallet | columns → badges |
| In → Out (principal) | `state.deposited` → `state.withdrawn` (token totals) |
| Harvested (fees + rewards) | `state.feesCollected` + `state.rewardsCollected` (the §22-relevant side) |
| Held | `closed_at − opened_at` (flag `inferredOpen` ⇒ lower bound) |
| §23? hint | derived: held `< 365d` → "§23 relevant" pill vs "outside 12mo (likely tax-free)" — **hint only** |
| Realized gain € | **Phase-2** → `pending tax engine` |

### 7.3 Last Actions — `/activity`

`recentActivity(db, { limit, cursor, chain?, wallet?, type?, positionId? })`, keyset-paged `(timestamp DESC, id DESC)`. One row per decoded event, all from real `events` columns:

| Cell | Source / note |
|---|---|
| Time | `timestamp` (relative + absolute on hover) |
| Chain | `chain` badge |
| **Protocol** | `parsePositionId(position_id).protocol` when present, **else `handler_id`** (which *is* the protocol slug, e.g. `orca_whirlpool`). `events` has no protocol column. Badge tolerates a free-string protocol. |
| Wallet | `wallet` → **label** (privacy) |
| Action (verb) | `(type, subtype)` → `lib/taxonomy.ts` map over the frozen 15-type taxonomy (e.g. `lp_deposit/open_position` → "Opened LP", `swap/trade` → "Swapped", `lp_fee/collect` → "Collected fees", `lend_borrow/borrow` → "Borrowed") |
| Sent / Received | `sent_asset`+`sent_amount` / `received_asset`+`received_amount` via `<AssetAmount>` |
| € value | per-leg `amount × getPrice(asset, utcDateOf(timestamp)).eur_price`; "—" + chip when no price row |
| Position | `position_id` → link to `/positions/:id` when present |
| Flags | `flags_json[]` → `<FlagPills>` |

```
/activity   chain ◇all  wallet ◇all  type ◇all  position ◇—            newest first
──────────────────────────────────────────────────────────────────────────────────
Time        Ch    Action              Sent         Received            €value   Pos      Flags
09:12 ·6/17 [base] Collected fees      —            88 USDC · 0.03 WETH €165    #84217   —
08:50 ·6/17 [sol]  Swapped             8 SOL        900 USDC            €830     —        looping
21:04 ·6/16 [sui]  Opened LP position  1200 USDC    (position obj)      —        0xabc…   —
… keyset "load more" on (timestamp, id)
```

### 7.4 Position detail — `/positions/[positionId]`

`getPositionDetail(db, positionId)` = row + `getEventsByPosition` timeline. The route param contains colons (`base:uniswap_v3:84217`, Sui type tags) — `decodeURIComponent` + validate with `parsePositionId` (throws → `not-found.tsx`). Three panels: **(1)** lifecycle timeline in canonical order (open → add/remove → collect/reward → close; `inferredOpen` → synthetic "history starts here" marker); **(2)** `state_json` breakdown (deposited/withdrawn/principal/fees/rewards/eventCount/lastEventAt/openTx/closeTx/warnings); **(3)** live-value panel (M2; until then the EUR-at-close estimate with the same caveat).

---

## 8. Other views

- **Overview `/`** — buildable now (minus tax cards): open/closed counts, per-chain event counts (`countEventsByChain`), unclassified backlog (`count(*) WHERE resolved_at IS NULL`), pending transfer-links (`count(*) WHERE status='pending'`), last-ingest (`max(raw_txs.fetched_at)`), harvested-to-date (Σ fees+rewards, est. EUR), recent-activity preview. **"Tax owed now" + Freigrenze meters = disabled Phase-2 placeholders.**
- **Transactions `/transactions`** — `listEventsPaged`-style view grouping `events` by `(chain, tx_hash)` (reuses `getEventsByTx` per tx). The audit/CSV-mirror surface; tx hash → block explorer (`explorerTxUrl`).
- **Monthly `/reports/monthly`** — Phase-2 gated. Pre-engine, may show the **income side that exists** (monthly Σ of `lp_fee`/`lp_reward`/`lend_reward` valued in EUR), labelled "income inflows, pre-engine — not the final §22 figure"; gain/Freigrenze panels disabled.
- **Yearly `/reports/yearly`** — Phase-2 gated stub (§23/§22 breakdown, per-asset, export) so the IA is complete.

---

## 9. Component & UI inventory

**shadcn/ui to install:** `card, table, badge, tabs, tooltip, dropdown-menu, skeleton, sonner, separator, scroll-area, command, select, progress, sheet, accordion`. No data-grid lib (table + manual sort is enough at solo scale and avoids React-18-capped deps).

**Recharts v3 charts** (client components fed serializable arrays — never `bigint`):
1. **Portfolio value over time** — `AreaChart` (Overview). *Heaviest query; see §13.* Render **at-cost** (`Σ principal × event-dated price`), axis labelled "at cost (EUR)". Candidate to **defer past M1**.
2. **Allocation** — `PieChart` donut, open positions grouped by protocol/chain, valued `principal × latest close`.
3. **Fees + rewards harvested** — stacked `BarChart`, `events WHERE type IN (lp_fee,lp_reward,lend_reward)` grouped by month. **Real data today** — income harvested, not §23 gain.
4. **Realized §23 gains by month** — `BarChart`. **Phase-2** → `<Phase2Placeholder>`.
5. **Freigrenze meters** — shadcn `progress` (not Recharts), both-branch cliff per doc 07 §3.3. **Phase-2.**

A single `chartConfig` maps series keys → `hsl(var(--chart-1..5))` so charts inherit dark mode.

**Domain components** (`components/`): `<ChainBadge>`, `<ProtocolBadge>` (tolerates free-string), `<WalletLabel>` (**label only, never address**), `<AssetAmount asset amount chain decimals?>` (resolves decimals via `canonicalAsset`; raw + "raw" badge on miss), `<FiatValue eur usd?>` (de-DE €, null→"—"), `<EventTypeLabel type subtype>` (taxonomy→verb+icon, exhaustive), `<FlagPills>`, `<PositionCard>` (live fields optional — no fake zeros), `<PositionsTable>`, `<ClosedPositionRow>`, `<ActivityFeed>`/`<ActivityRow>`, `<PositionTimeline>`, `<TaxMeter>` (Phase-2), `<StatTile>`, `<Phase2Placeholder>`.

**Formatting (`lib/format.ts`, `lib/explorer.ts`):** `formatTokenAmount(amount, decimals)`, `formatEur`/`formatUsd` (de-DE / en-US), `relativeTime`/`formatDate`, `truncateHash` (**tx hashes only — there is deliberately no wallet variant**), `explorerTxUrl(chain, hash)` → basescan / solscan / suivision.

**Derived metrics** (formula · provenance):
| Metric | Formula | Inputs |
|---|---|---|
| days-until-tax-free | `(opened_at + 365d − now)/86400` | `opened_at` (now); per-lot accuracy = Phase-2 |
| APR (fees) | `(harvestedFeesEur / costBasisEur) × 365/ageDays` | `state.feesCollected` × price; cost basis × entry price; "—" if entry price uncached |
| IL / value delta | `currentValueEur − costBasisEur` (and %) | currentValue = **live (M2)**; cost basis from `principal` × entry price. Omit row (no zero) without live read. |
| current value / unclaimed fees | live on-chain | §10; not in DB |

**States:** `<Suspense>` skeletons; distinct empty states naming the CLI command that populates them ("Run `bun run cli ingest` then `decode`"); `error.tsx` catches **SQLITE_BUSY** specifically ("Database is being updated, retrying…", auto-retry — `busy_timeout` usually absorbs it). Dark default via `next-themes` + CSS vars. Responsive shell: sidebar collapses to a `sheet` below `md`.

---

## 10. Live on-chain reads (M2 slice)

The numbers that change every block — **current principal value** and **unclaimed fees/rewards** — are fetched per protocol at request time and merged onto `positions` rows by `position_id`. **Read-only against chain; never writes the DB; degrades gracefully.**

**Where it runs:** Route Handler (`app/api/positions/live/[positionId]/route.ts`), not a Server Component render path. Flow: the page renders **instantly** from `state_json` + `prices`; a client component then fetches live values (SWR, revalidate-on-focus) and **patches** each card. On failure the card keeps decoded values + a "live unavailable" badge — failures are **per-position**, never global.

**Per-protocol recipe** (SDKs are already deps; reuse the client factories from `src/chains/*` — the live layer reads `position.wallet` from the row and **never re-reads `config/wallets.ts`**):

| Protocol (chain) | SDK | Call | Key | Caveat |
|---|---|---|---|---|
| Uniswap V3 (base) | viem | `positions(tokenId)` + pool `slot0()` + **simulated** `collect()` (`eth_call`, `from`=owner) | `ALCHEMY_API_KEY` | collect is a simulation, not a tx; v3 tick math for principal split |
| Aerodrome (base) | viem | `LpSugar.positions(account)` lens (+ `VotingEscrow.locked` for ve) | `ALCHEMY_API_KEY` | pin LpSugar address; one call per wallet |
| Orca Whirlpool (sol) | `@solana/kit` + `@orca-so/whirlpools` | `fetchPositionsForOwner` + `harvestPositionInstructions` **quote** | `HELIUS_API_KEY` | Web3.js v2; cache hard (credit cost per fetch) |
| Navi (sui) | `@naviprotocol/lending` | `getLendingState` + `getUserAvailableLendingRewards` | `SUI_RPC_URL` | **devInspect-heavy** — needs a dedicated endpoint (doc 07 §2.1) |
| Turbos (sui) | `turbos-clmm-sdk` | `getOwnedObjects` + `getUnclaimedFeesAndRewards` | `SUI_RPC_URL` | devInspect; pin position type tag |
| Suilend (sui) | `@suilend/sdk` (npm) | obligation read → deposits/borrows per reserve | `SUI_RPC_URL` | pin + smoke-test the npm SDK |

**TTL cache:** in-memory only (a cache *table* would break the single-writer topology) — `Map<positionId,{result,expires}>`, ~30s base / ~60s sui+sol, plus Route Handler `revalidate`. `?refresh=1` bypasses.

**Computable now** (no engine): `currentValueEur`, `unclaimedFeeEur`, `netVsEntryEur` (labelled "pre-tax estimate"), `daysToTaxFree` (position-level approx). **Blocked on Phase-2:** realized §23 gains, the headline "tax owed now" (needs FIFO disposals + Freigrenze cliffs + §32a + Soli/Kirchensteuer), and per-lot-accurate `daysToTaxFree`.

---

## 11. Capability matrix — buildable now vs Phase-2

| View | Status | Needs |
|---|---|---|
| Overview (net worth, last actions) | **PARTIAL — now** | rollups + `recentActivity`; tax cards = Phase-2 placeholders |
| **Current Positions** | **NOW** | `listPositions({openOnly})` + `positionState` (exist); cost-basis valuation |
| **Last/Closed Positions** | **NOW + 1 query** | `listClosedPositions` (new option); §23 gain = placeholder |
| **Last Actions / Activity** | **NOW + 1 query** | `recentActivity` (new) |
| Transactions | **NOW + 1 query** | `listEventsPaged` (new) |
| Position detail | **NOW + 1 query** | `getEventsByPosition` (new); realized-gain annotation = placeholder |
| Monthly / Yearly reports | **BLOCKED — Phase-2** | `tax_lots`/`disposals`, §23/§22, Freigrenzen, §32a |
| Live current value / unclaimed fees | **NOW with keys (M2)** | `ALCHEMY`/`HELIUS`/`SUI_RPC_URL` |

No schema changes for M1/M2 — the existing 7 tables + indexes cover every read. (Optional, CLI-owned, only if needed at scale: `events(timestamp)` index for the global feed; a daily snapshot table to make the portfolio chart cheap. Phase-2 adds `tax_lots`/`disposals`.)

---

## 12. Decisions for Felix (recommendations preselected)

1. **"Current value" source for M1** → `principal × daily-close EUR` (deterministic, no keys), labelled "cost-basis, not live"; live SDK reads land in **M2**. *Confirm the cost-basis label is acceptable rather than withholding the view.*
2. **Ship order** → ship **M1 + M2 before** Phase-2 completes; gate **M3** (tax reports) behind the engine. Delivers the three named views early without faking tax numbers.
3. **Dark vs light** → **dark** default + toggle (solo tool; CSS-var dark mode per doc 07).
4. **§23 hints on closed positions pre-engine** → structural placeholders labelled "requires tax engine (Phase 2)"; never compute a partial gain.
5. **Decimals registry exhaustiveness** → if `canonicalAsset` misses assets that appear in `events`/`positions`, **extend `src/linker/assets.ts`** (shared with CLI), not a dashboard-local map.
6. **EUR-missing policy** → show "price pending"; do **not** derive EUR from USD×FX in the dashboard (would introduce a second, mixable price convention — see doc 07 §2.2 item 4).
7. **Portfolio-over-time chart** → in M1 or deferred? It's the heaviest query and not part of the named ask; recommend deferring or shipping read-only "at cost".

---

## 13. Reconciliations / corrections (folded in from the design critique)

The 5-way fan-out produced a few cross-section inconsistencies; resolved here (verified against source) so there is one source of truth:

- **Token decimals already exist** in `src/linker/assets.ts` (`canonicalAsset → {symbol, decimals}`). Earlier section drafts wrongly claimed "decimals are stored nowhere" and proposed a new map — **dropped**. Use `canonicalAsset`; extend it in `src/` if not exhaustive (§4c, §12.5). *(Note: `src/chains/base/tokens.ts` and `sui/coins.ts` are symbol-only maps — they are not the decimals source.)*
- **Import specifier** is **`liquidity-tax/db/schema`** (unscoped), not `@liquidity-tax/...`. Root `package.json` has no `workspaces`/`exports` today — §3 is the source of truth for adding them.
- **One activity-feed query**: `recentActivity(... cursor:{timestamp,id})` keyset-paged (a single `before:timestamp` can't break ties). Dropped the duplicate `listActivity`/`getRecentEvents` names.
- **One closed-positions query**: extend `ListPositionsOptions` (`closedOnly`/`limit`/`orderBy`) and expose `listClosedPositions` as a thin wrapper — keeps a single `listPositions`.
- **Two batched price queries**: `getPricesForPairs(pairs)` + `getLatestPrices(assets)`. Dropped the four overlapping names.
- **Activity-feed protocol** is derived (`parsePositionId` else `handler_id`, which *is* the protocol slug) — `events` has no protocol column; badge tolerates a free string.
- **EUR-at-close** caveat for **negative `principal`** (suppress the rollup, show signed per-asset) — §7.1.
- **Global feed** is a scan+sort (no timestamp-only index); any index is a CLI-owned migration — §5.

---

## 14. Milestone build plan (Phase 3; doc 07 budget 4–6d + 2–3d live slice)

- **M1 — read-only skeleton + the three named views (~3–4d).** Workspace wiring (§3), readonly `lib/db.ts`, shadcn shell + dark mode. **Current Positions**, **Last/Closed Positions**, **Activity feed**, **Position detail**, **Transactions**, **Overview** (tax cards disabled). New queries: `recentActivity`, `getEventsByPosition`, `listClosedPositions`, `getPositionDetail`, batched prices. Cost-basis EUR valuation. *No keys, no Phase-2.*
- **M2 — live on-chain slice (~2–3d).** Per-protocol live value + unclaimed fees (§10), IL/APR/days-to-tax-free, render-first/hydrate-second. Needs RPC keys; mind Sui rate limits (dedicated endpoint).
- **M3 — tax views (after Phase-2 engine, ~1–2d on top of it).** Monthly + Yearly over `disposals`/`tax_lots`, Freigrenze meters (both branches), per-asset breakdown + export.

---

## 15. Risks / caveats

- **bigint serialization** — stringify at the query boundary (`lib/serialize.ts`); React can't serialize `bigint` over the RSC boundary.
- **WAL readonly** — never migrate from the dashboard; keep `data/` writable for `-wal`/`-shm`; `busy_timeout=5000` absorbs the CLI's short writes.
- **Recharts SVG** on dense series → ECharts fallback (doc 07); downsample server-side for long ranges.
- **Sui public-node rate limits** — M2 devInspect reads (Navi/Turbos/Suilend) need a dedicated endpoint.
- **Privacy** — wallets shown by **label** only, never raw addresses, never in URLs/logs. `events.wallet`/`positions.wallet` hold addresses; resolve to labels server-side at render.
