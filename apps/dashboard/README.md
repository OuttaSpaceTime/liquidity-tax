# @liquidity-tax/dashboard

Next.js (App Router) + React dashboard for the liquidity-tax CLI. **Read-only** view
over the same SQLite DB the CLI writes — current positions, last (closed) positions,
last actions (activity feed), per-position lifecycle, a transactions audit view, and an
overview. The tax-report views are Phase-2-gated stubs (see below).

Design spec: [`.claude/docs/planning/08-dashboard-definition-20260617.md`](../../.claude/docs/planning/08-dashboard-definition-20260617.md).

## Run

From the repo root:

```sh
bun install          # once (installs the workspace, incl. this app)
bun run dashboard     # next dev on http://localhost:4848  (Bun runtime)
```

Or from this directory:

```sh
bun --bun run dev      # dev server
bun --bun run build    # production build
bun --bun run start    # serve the production build
```

`DB_PATH` defaults to `../../data/liquidity-tax.db` (the CLI's DB); override via env.
The app opens the DB **readonly** with `busy_timeout=5000` — the CLI stays the sole
writer (WAL two-process topology).

## Notable implementation choices (deviations from doc 07/08, flagged here)

- **Runtime = Bun, not Node.** Run with `bun --bun`. This lets the dashboard reuse the
  CLI's `bun:sqlite` repos directly and the `loadWallets()` privacy indirection (a native
  TS dynamic import) instead of porting to `better-sqlite3`. Doc 07 defaulted to Node over
  a Bun-Next segfault concern; `next build` + `next start` were verified stable here.
  Switching to Node later means swapping `lib/db.ts` to `drizzle-orm/better-sqlite3` and
  reworking `lib/wallet-labels.ts`.
- **Styling = hand-written CSS (`app/globals.css`), not shadcn/Tailwind + Recharts.** A
  pure styling layer for a guaranteed clean build; the data layer is unaffected. Swapping
  in shadcn/Recharts later is a presentation-only change.
- **Almost all server components.** Filters and pagination are URL-`searchParams` driven
  (`?chain=…&type=…&count=…`); the only client component is the sidebar (active highlight).
  No charts yet.

## Privacy

`events.wallet`/`positions.wallet` hold raw addresses; the UI renders **labels only**,
resolved server-side via `loadWallets()`. Configured EOAs show their label; unmapped
addresses (e.g. Sickle/vfat proxy contracts that appear as `wallet`) get a stable
`wallet-xxxxxx` fingerprint — never the raw address. EVM matching is case-insensitive
(events store lowercased addresses; the config may use checksums).

## What's implemented (M1) vs deferred

- **Built now (reads existing schema):** Overview, Current positions, Last/closed positions,
  Position detail (lifecycle timeline + state), Activity feed, Transactions.
- **Deferred — live on-chain reads (M2):** current value / unclaimed fees right now (needs
  RPC keys; doc 08 §10). Cards show the cost-basis EUR estimate until then.
- **Deferred — tax views (M3, Phase-2 engine):** Monthly/Yearly reports, realized §23/§22,
  Freigrenzen, §32a. Rendered as labelled stubs; no fabricated tax numbers.

## Shared queries

New read queries were added to the CLI repos (shared, test-covered):
`recentActivity`, `getEventsByPosition`, `listTransactions` (`src/db/repos/events.ts`),
`listPositions` closed/limit/orderBy options (`src/positions/repo.ts`),
`getPricesForPairs`, `getLatestPrices` (`src/prices/repo.ts`). Presentation shapes
(DTOs, valuation, formatting, labels) live in `apps/dashboard/lib`.
