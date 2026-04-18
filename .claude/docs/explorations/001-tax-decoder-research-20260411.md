# Multi-Chain DeFi Tax Decoder — Research & Design Exploration

**Date:** 2026-04-11
**Status:** Exploration complete. Ready for `/plan`.
**Author:** Felix + Claude (explore-solutions session)
**Supersedes:** N/A (first exploration of this direction)

---

## 0. Executive Summary

Felix is currently tracking cryptocurrency liquidity-pool positions manually in a
Google Sheet (`liquidity-sheets` repo). This exploration was triggered by a
desire to replace the sheet workflow with an application that reads directly
from on-chain sources — but the *actual* unmet need turned out to be
**tax-grade transaction history** for a German tax filing, not a portfolio
dashboard. Existing consumer tax tools (Koinly, CoinTracker, Accointing) fail
on concentrated-liquidity LPs and looped lending positions because their
decoders can't classify the event streams correctly.

**The recommendation is to build a headless TypeScript CLI that:**

1. Ingests raw transactions for hardcoded wallet addresses on Base, Solana,
   and Sui.
2. Decodes them through per-protocol handlers (Whirlpools, Aerodrome,
   Uniswap V3, Aave V3, Turbos, Navi, Suilend) that follow the pattern established by
   `staketaxcsv`.
3. Stores a canonical event log in local SQLite.
4. Exports a Koinly-compatible CSV for import into any mature tax tool.
5. Falls back to a transfer-firehose + manual-label TUI for any transaction
   that no handler recognizes.

Explicitly **out of scope** for the MVP: React UI, tax engine (FIFO / §23
Haltefrist), multi-user support, authentication, hosted deployment, and any
chains or protocols Felix does not personally use.

This document captures the full depth of research and decision-making that
led to this recommendation, including options considered and rejected,
competing architectures, and the reference code bases that should inform
implementation.

---

## 1. Problem Framing

### 1.1 Original request

> "I want to build an application in React that reads my portfolio from
> Base chain and Orca on Sol chain that I will be using for tax tracking
> and for Sui, because most UIs I tried have bad workflows and don't give
> me not enough flexibility. However right now I am not sure if this is a
> good idea and whether we can have good data sources for liquidity pool
> tracking, I also had some lending and looping positions."

### 1.2 Current state

- Felix tracks LP positions manually in a Google Sheet via the skills in
  this repo (`/add-position`, `/harvest`, `/close-position`,
  `/close-and-harvest`). The workflow is functional but tedious.
- Portfolio includes active positions on Orca (Solana) and Uniswap V3 /
  Aerodrome (Base), and has included lending + liquid-staked looping
  positions on Sui (via Navi / Suilend).
- Historically used **multiple wallets** across the relevant chains
  (Rabby, Coinbase Wallet, Phantom).

### 1.3 Frame-refining Q&A (captured during Checkpoint 1)

Two clarifying questions during framing changed the direction of the
entire exploration:

**Q1: Tax vs portfolio — which is the primary goal?**
→ *Tax is the first real use case. Portfolio view is secondary.*

**Q2: Solo-use, or eventually share / sell as a product?**
→ *Solo-use only.*

**Q2a: Sui scope?**
→ *Only Turbos for CLMM LPs; Navi for liquid-staked looping; Suilend for
lending.* (Cetus, Bluefin out of scope.)

**Q3: Compute tax lots end-to-end, or emit CSV for a downstream tool?**
→ Initially: *compute in the app, because the downstream tools are very
hard to get right.* Then, after discussing that classification (not math)
is the actual problem the existing tools fail at: *a clean CSV that Koinly
and friends accept is acceptable, because the downstream math over a
correctly-classified CSV is trivial.*

**Q4: German tax jurisdiction?**
→ *Germany (§23 EStG, 1-year Haltefrist for crypto).*

### 1.4 Implications of the refined frame

- **Solo + tax-primary** pushes hard toward a local-first ingestion
  pipeline. No hosting, no auth, no cloud persistence. The raw transaction
  log is the source of truth; positions and tax lots are views.
- **Germany** means Rotki had an initial claim to attention — Rotki is
  German, implements §23, and already handles FIFO + Haltefrist. If the
  project had required a tax engine, Rotki would likely have been the
  winner.
- **CSV-export as the finish line** (instead of a full tax engine) shrinks
  the project by an order of magnitude. The hard part becomes
  *classification of on-chain events*, not tax math.
- **Hardcoded wallets** eliminates the need for wallet-connect UX and most
  of the product surface area usually associated with "a crypto app."

### 1.5 Known constraints

| Constraint | Source | Impact |
|---|---|---|
| Budget ceiling ~$50-100/mo | Felix, solo personal use | Rules out paid enterprise APIs (DeBank Pro, Nansen, etc.) |
| German tax rules (§23 Haltefrist) | Jurisdiction | Tax math, if ever implemented, must honor 1-year holding period |
| No product ambition | Felix | No multi-tenancy, no auth, no UX polish requirements |
| Three chains required | Portfolio | Base (EVM), Solana, Sui — no single API covers all three |
| CLMM + looping must work | Portfolio | The core complexity that Koinly et al. can't handle |

---

## 2. Data Source Research (Pass 1 — APIs and Hosted Services)

This section captures the first research pass: what APIs exist to read
on-chain wallet activity and decode it into meaningful events across Base,
Solana, and Sui.

### 2.1 Multi-chain portfolio aggregators

#### Zerion API (`zerion.io/api`)

- **Supported chains:** 38+ including Ethereum, Base, Arbitrum, Optimism,
  Polygon, Avalanche, **Solana**. Non-EVM coverage limited to Solana,
  XDC, 0G.
- **Sui:** **Not supported.** Confirmed on their
  [supported-blockchains docs](https://developers.zerion.io/reference/supported-blockchains).
- **Solana coverage:** tokens, positions, and transactions supported;
  DeFi protocols and NFTs listed as "coming soon." This matters — it
  means Zerion does *not* currently decode Orca Whirlpool positions to
  tax-grade detail.
- **Pricing:** Free tier ≈ 3k requests/day; paid tier $499/month for
  ~1M requests. Free tier is plenty for a single user.
- **Schema:** Same endpoint shape for EVM and Solana.
- **Verdict:** Excellent for Base; acceptable for Solana transaction
  history but not for Solana CLMM position details; **useless for Sui**.

#### Zapper API (`build.zapper.xyz`)

- **Supported chains:** 60+ chains via GraphQL.
- **Pricing:** 10,000 free API points per month (v2/balances costs 7
  points/query, others 1 point). Paid model is **bulk point purchase**
  starting at $10,000 — not a subscription, not suitable for a
  single-user tax app unless you stay inside free limits.
- **Verdict:** Free tier is too tight for historical backfill of years of
  activity; pricing model is hostile to solo use.

#### DeBank API / OpenAPI

- **Supported chains:** 90+ EVM chains + Solana.
- **Pricing:** No meaningful free tier; compute-unit pricing is opaque
  and hard to budget for solo use.
- **Verdict:** Broad coverage, painful economics. Also no Sui support.

### 2.2 Generic EVM indexers (Base coverage)

#### Covalent / GoldRush (`goldrush.dev`)

- **Free tier:** 100k credits/month at 5 RPS. Plenty for a single user.
- **Paid:** Starts at $50/month.
- **Base coverage:** Full, from genesis, with decoded logs and pricing.
- **Verdict:** Excellent free fallback/cross-check for Base. Works well
  for raw transaction history but does not semantically decode CLMM
  positions.

#### Moralis, Alchemy, QuickNode

- All reasonable EVM indexers with Base support. None meaningfully
  decode CLMM positions at the protocol level — they give you decoded
  logs, not semantic events.
- **Verdict:** Interchangeable as RPC providers.

### 2.3 Solana-specific

#### Helius (`helius.dev`)

- **Free tier:** 1M credits, 10 RPS, 1 sendTransaction/sec. DAS calls
  cost 10 credits; Enhanced Transactions calls cost 100 credits. That
  caps the free tier at ~10k enhanced-tx calls/month.
- **Developer tier:** $49/month for 10M credits, 50 RPS.
- **DAS & Enhanced Transactions:** Available on all tiers. Enhanced
  Transactions attempts human-readable descriptions but is not tax-grade.
- **Whirlpool position decoding:** Not done by Helius directly. You'd
  use Helius as RPC + `@orca-so/whirlpools-sdk` as the decoder.
- **Verdict:** Baseline for serious Solana work. Free tier may be enough
  for a solo user if you cache aggressively.

#### Orca public API (`api.orca.so/docs`) — verified

- Endpoints are **pool-level only**: `/pools`, `/pools/{address}`,
  `/pools/search`, `/lock/{address}`, `/tokens`, `/protocol`.
- **No wallet-position endpoint exists.** This was verified by fetching
  the actual OpenAPI spec.
- **Verdict:** Cannot be used to query "what are this wallet's
  Whirlpool positions?" You must decode via the Whirlpools SDK against a
  Solana RPC yourself.

#### Whirlpools SDK (`@orca-so/whirlpools-sdk`)

- **Official TypeScript SDK** from Orca. Open source at
  [orca-so/whirlpools](https://github.com/orca-so/whirlpools).
- Provides `getPositionData`, `collectFees`, `updateFeesAndRewards`,
  tick-math helpers, and all primitives needed to decode a position NFT
  into current token amounts + accrued fees.
- **Critical gotcha**: you must call `update_fees_and_rewards` in the
  decoder logic before reading `fee_owed_a` / `fee_owed_b`, or you'll
  read zero. This is documented widely but still trips people up.
- **Verdict:** This is the authoritative path for Orca position data.

### 2.4 Sui ecosystem

#### BlockVision Sui Indexing API (`docs.blockvision.org`)

- 14 endpoints including `Account Activity`, `Account Coins`, `Account
  NFTs`, `Account DeFi Portfolio`, plus coin and NFT metadata.
- **DeFi Portfolio endpoint exists** but its protocol coverage is not
  publicly documented. SuiVision (same company, end-user product) is
  known to display positions on Cetus, Navi, Scallop, Kriya — so the
  underlying data exists, but API-level details aren't clear.
- **Free tier:** Only a 30-call trial. Beyond that, Pro membership
  required with no published pricing.
- **Verdict:** Worth contacting directly if the direct-RPC approach
  proves too painful. Not the first choice.

#### Direct Sui RPC + protocol SDKs

- Sui public RPC endpoints are free. Authenticated providers (BlockVision,
  Shinami) offer higher rate limits at modest cost.
- **Navi SDK (`naviprotocol/navi-sdk`)**: Official TypeScript SDK. Includes
  deposit, borrow, repay, liquidate, claim rewards, flash loans, oracle
  queries, health factor. Also has a DEX aggregator with
  Cetus/Bluefin/Turbos/Aftermath/DeepBook.
- **Turbos SDK**: Official TypeScript SDK for the Turbos CLMM. Less
  widely used than Cetus but fully featured.
- **Suilend SDK**: Official TypeScript SDK.
- **Verdict:** This is the authoritative path for Sui position data. No
  shortcut exists.

### 2.5 Historical pricing

#### CoinGecko API

- **Demo tier:** Free, 30 calls/min, 10k calls/month, 12 years of history
  with 5-minute granularity.
- **Paid Pro:** Starts ≈ $129/month but unnecessary for solo use.
- **Used in production by:** Awaken (crypto tax tool), Rotki, many others.
- **Verdict:** Primary pricing source. Cache aggressively — rate limit is
  the only practical constraint.

#### DefiLlama coins API

- Free, unauthenticated, reasonable rate limits. Coverage is broader
  than CoinGecko for long-tail DeFi tokens.
- **Verdict:** Free fallback and cross-check for CoinGecko.

### 2.6 Reference: Rotki

- Self-hosted, open-source (MIT), Python backend + Vue frontend.
- Decodes on-chain DeFi events locally, supports Aave, Compound,
  Uniswap, MakerDAO, Yearn, Curve, Aerodrome, Velodrome, Jupiter, and
  more.
- Has a built-in **tax engine** with FIFO/LIFO/HIFO and — critically —
  **first-class German §23 Haltefrist support**.
- Covers EVM + Solana. **No Sui support** as of 2026-04.
- Active development (multiple commits/week), ~250 contributors.
- **Initially the front-runner** when the scope included a tax engine.
  Became less compelling once scope dropped to CSV-export-only.

### 2.7 Summary of data-source research

| Need | Best option | Cost | Gap |
|---|---|---|---|
| Base tx history | Zerion (free) or GoldRush (free) | $0 | None |
| Base LP decoding (Uniswap V3, Aerodrome) | viem + contract reads + subgraphs | $0 | Handler required |
| Base lending decoding (Aave V3) | viem + contract reads; Rotki decoder as reference | $0 | Handler required |
| Solana tx history | Helius (free or $49) | $0-$49/mo | None |
| Orca Whirlpool position decode | `@orca-so/whirlpools-sdk` | $0 (code) | Handler required |
| Sui tx history | Public Sui RPC | $0 | None |
| Sui LP / lending decode | `turbos-sdk`, `navi-sdk`, `suilend-sdk` | $0 (code) | Handler required |
| Historical prices | CoinGecko Demo | $0 | None |
| German §23 tax math | Rotki (if adopted) OR own impl | $0 | Not needed in MVP |

**Key conclusion:** No single API covers all three chains with tax-grade LP
awareness. Per-chain integration is unavoidable. The realistic monthly
cost floor is **$0 initially (Helius free tier)**, rising to **~$49/mo**
if Helius free tier proves too tight during a one-time backfill.

---

## 3. Scope Reframe — From Tax Engine to CSV Export

This was the pivotal moment in the exploration. Originally Felix wanted the
tool to *compute* the German tax directly, based on past frustration with
existing tools getting the numbers wrong. After walking through what
actually goes wrong in those tools, we reframed:

### 3.1 What Koinly / CoinTracker / Accointing actually fail at

They do **not** fail at FIFO math. They fail at **event classification**:

1. A Whirlpool "close position" shows up as a raw sequence of token
   transfers. The tools don't know whether each transfer is principal
   withdrawal or fee harvest, and they price the combined transfer as a
   single swap. The resulting tax events are wrong at the source.
2. Navi looping (stake SUI → receive haSUI → deposit as collateral →
   borrow SUI → re-stake) produces a multi-tx sequence the tools
   classify as a series of disconnected disposals. The correct
   interpretation (is the borrowed SUI a disposal when re-staked?
   German §23 gives no clean answer) requires human judgment, encoded
   as a rule.
3. Aerodrome slipstream rewards (AERO emissions) and trading fees are
   distinct taxable events emitted by the same transaction. The tools
   often mis-label both as "trade."

**The observation that unlocked the reframe:** the tax math is easy once
the classification is correct. FIFO on a few hundred well-classified rows
is a handful of SQL queries or a spreadsheet formula. The *classification*
is the hard part, and nothing on the market does it well for Felix's
specific protocols.

### 3.2 The new goal

> **Produce the world's best event-level CSV for Felix's specific wallet
> activity, covering Orca Whirlpools, Aerodrome slipstream, Turbos,
> Navi, and Suilend. Export in Koinly's custom CSV format. Let Koinly (or
> a small spreadsheet, or Rotki's CSV importer, or a future Phase 2 tax
> engine) do the FIFO + Haltefrist math downstream.**

This is a categorically smaller project than "build a crypto tax app." It
is a **decoder**, not a tax tool.

### 3.3 Deferred decisions

- **Tax engine**: may be added in Phase 3 if Koinly proves insufficient
  even with a clean CSV. If added, it will be small — because the data is
  already clean — and German §23 logic is ~100 lines of date arithmetic
  on a sorted event log.
- **React UI**: may be added in Phase 2 if browsing the raw SQLite
  becomes painful. Core pipeline runs headless.
- **Portfolio dashboard**: not the point. The Google Sheets workflow can
  continue unmolested during build.

---

## 4. Architectural Options Considered

Three options were developed to the "pros / cons / risks / comparison"
level of detail. They are presented here in full for future reference.

### 4.1 Option 1 — Custom TypeScript decoder, local SQLite, CSV export ★ *recommended*

#### Concept

A headless TypeScript CLI. Per-chain ingest adapters pull raw transaction
data into SQLite; per-protocol decoders parse those raw transactions into
a canonical event log; an exporter emits Koinly-compatible CSV. No UI, no
server, no authentication. Single-user, single-machine.

#### Shape

```
src/
  chains/
    base/           # viem + public RPC / Alchemy
    solana/         # @solana/web3.js + Helius RPC
    sui/            # @mysten/sui + public Sui RPC
  decoders/
    orca-whirlpool.ts
    aerodrome-slipstream.ts
    turbos-clmm.ts
    navi-lending.ts
    suilend.ts
  prices/
    coingecko.ts    # historical USD at tx timestamp, cached
  db/
    schema.sql      # raw_txs, events, rules, prices, unclassified
    events.ts
  export/
    koinly-csv.ts
  fallback/
    tui.ts          # ink-based manual labeller for unclassified txs
config/
  wallets.ts        # hardcoded addresses per chain
```

#### Canonical event row

```typescript
type Event = {
  txHash: string;
  chain: 'base' | 'solana' | 'sui';
  timestamp: number;          // unix seconds
  kind:
    | 'swap'
    | 'lp_deposit' | 'lp_withdraw' | 'lp_fee_harvest'
    | 'lend_deposit' | 'lend_withdraw' | 'borrow' | 'repay'
    | 'reward' | 'stake' | 'unstake'
    | 'transfer_in' | 'transfer_out' | 'self_transfer';
  sent?:     { asset: string; amount: string };
  received?: { asset: string; amount: string };
  feeUsd?: number;
  priceUsd?: number;          // USD value of the event at timestamp
  protocol?: string;
  positionId?: string;        // Whirlpool NFT, Uni v3 token ID, Navi obligation, etc.
  notes?: string;
};
```

#### Pros

- **Minimal surface area.** No frontend, no auth, no deploy target. A v1
  for Base alone is a weekend.
- **Every target protocol has an official TypeScript SDK.** You consume
  existing code; you do not reverse-engineer.
- **SQLite as source of truth** makes the pipeline idempotent. Rerunning
  the decoder against the same raw txs yields the same events. You can
  improve decoder logic and re-decode without losing history.
- **Phase-gated.** Nothing blocks adding a UI or a tax engine later —
  they read from the same SQLite.
- **Follows the established pattern** used by staketaxcsv, Rotki, perfi,
  and dali-rp2 (per-protocol handlers).

#### Cons

- You own every line of decoder logic. No community to share bugs with.
- No tax engine means you verify correctness only end-to-end: the CSV
  is "right" when Koinly accepts it *and* the resulting tax report
  matches expectation. Feedback loops are slow.
- Historical price caching is tedious but necessary. First full backfill
  will fight CoinGecko rate limits.

#### Risks

1. **Decoder edge cases — the central risk.** Each protocol has a handful
   of happy-path shapes and ~15-20 edge cases. Concrete examples:
   - **Orca Whirlpool**: position-NFT transfers (you
     sent/received the position, not the underlying), partial
     withdrawals, `update_fees_and_rewards` gotcha, rebalance via
     collect-and-reopen, rewards in a third token vs SOL.
   - **Navi looping**: is the re-stake of borrowed SUI a taxable
     disposal? Policy decision, not a decoder decision; German §23 has
     no direct answer.
   - **Aerodrome slipstream**: gauge rewards vs LP trading fees are
     distinct event types in the same transaction.
   - **Suilend**: interest accrues continuously; only materialize tax
     events on deposit/withdraw/repay, never per-block.
2. **Rate limits on multiple parallel services.** Helius + Sui RPC +
   CoinGecko + potentially Zerion; one schema change breaks the
   pipeline. **Mitigation:** thin adapter interface per service; record
   raw responses to disk; replay offline for decoder tests.
3. **Test-data scarcity.** You can't unit-test against synthetic data
   because the edge cases come from real on-chain weirdness. **Mitigation:**
   first job of the project is to dump all historical txs to JSON, hand-
   label ~20 of the gnarliest ones, and use those as the test suite.
4. **Self-inflicted scope creep.** "While I'm at it..." kills solo
   projects. **Mitigation:** hard-code wallet addresses in config; refuse
   to generalize; write `now/later/out` into the repo and enforce it.

### 4.2 Option 2 — Rotki-as-decoder hybrid (rejected)

#### Concept

Don't rebuild what Rotki already decodes correctly. Run Rotki headlessly
as a decoder for **Base + Solana**, using its community-maintained handlers
for Aave, Uniswap V3, Aerodrome, Morpho, Moonwell, Jupiter. Write a
small custom TypeScript decoder for **Sui only** (Turbos + Navi +
Suilend). Merge both outputs into one canonical SQLite DB; export from
there. Your repo stays small.

#### Why it was initially attractive

- Rotki's Base/EVM decoders are *mature*. Saving weeks on Aerodrome +
  Uniswap V3 alone is real.
- Rotki has German §23 logic if you ever want the tax engine back.
- Rotki could serve as a *cross-check* even if not used as the primary
  source.

#### Why it was rejected

**The Orca Whirlpool CLMM gap.** Rotki's Solana support is recent (late
2024 / early 2025) and mostly covers basic transfers, staking, and Jupiter
swaps. Concentrated-liquidity position NFTs, fee harvests, and tick-math-
specific events are almost certainly **not decoded to tax-grade detail**.

This collapses the entire value proposition: you'd start as a consumer
of Rotki, hit the gap on Orca, and end up patching Python decoders,
maintaining a fork of a 200k-LOC Python codebase, and learning SQLAlchemy
— all for benefits that were never going to materialize on the chain
(Solana) where you most needed decoding help.

**Other cons that mattered:**

- Two codebases, two languages. Solo-project context switches are
  expensive.
- Normalization between Rotki's `HistoryEvent` schema and your canonical
  schema adds a persistent mapping layer that must evolve with Rotki's
  upstream changes.
- External-process dependency: the pipeline becomes "start Rotki, wait
  for sync, then run your script" instead of `npm run sync`.
- Helius is still in the picture — Rotki's Solana fetcher is Helius-backed
  anyway. You'd pay for Helius *and* run Rotki's stack around it.

**Conclusion:** Option 2 is only defensible if Rotki's Base decoders save
more time than the Python maintenance + Orca gap cost. Given that Base
protocols (Uniswap V3, Aerodrome) have mature TypeScript SDKs readable via
viem, and that Orca is the *primary* CLMM exposure, the economics do not
work. **Rejected.**

### 4.3 Option 3 — Transfer-firehose + human-in-the-loop classifier (promoted to fallback layer)

#### Concept

Invert the problem. Don't decode protocols up front. Pull the **raw token
transfer + balance-change stream** per wallet (free from every indexer),
group transfers by tx hash, and present each unresolved tx in a TUI for
interactive classification. Label the first instance of each shape
once; the tool remembers and auto-classifies identical shapes on future
runs.

#### Why it's compelling

- **Smallest possible codebase.** ~500-1000 LOC. No SDKs, no tick math,
  no Move module parsing.
- **Correctness by construction.** You are the domain expert. Each new
  pattern gets labeled once, by you, and you know it's right. No silent
  decoder bugs.
- **Chain-agnostic.** Adding a fourth chain is "write an ingest adapter
  that returns `{ txHash, timestamp, transfers[], logs[] }`." That's it.
- **Survives protocol upgrades.** Protocol V2 breaks an SDK integration;
  a transfer-firehose classifier just learns one new rule.
- **Aligned with Felix's current workflow.** He already labels positions
  manually in Google Sheets. A TUI is the same mental model, faster.

#### Why it's not the primary strategy

The Pass-2 research (section 5) revealed that:

1. Every mature open-source tool in the space uses per-protocol handlers.
2. Handlers are not actually harder to write than hand-labeling for
   *well-understood* protocols with SDKs.
3. Handlers produce a reusable, testable, versionable artifact;
   hand-labels produce SQLite rows that are hard to migrate when your
   interpretation changes.
4. For Felix's specific protocol set (all of which ship official TS
   SDKs), the decoder path dominates for the common case.

But the firehose idea remains valuable for a **critical edge case**: any
transaction that no handler recognizes. Instead of either (a) ignoring it
or (b) crashing, the pipeline dumps it into an `unclassified` table, and
a small TUI lets Felix label it. Labels either:

- Become a new rule that classifies future matching txs automatically
  (pattern-match on contract address + log signature), or
- Trigger Felix to write a new handler for the protocol.

**Verdict:** Option 3's core idea is absorbed into Option 1 as a fallback
mechanism. It is not a competing architecture in the final
recommendation; it is a safety net that makes Option 1 robust against the
long tail of unknown txs.

### 4.4 Options not seriously considered

A few were evaluated briefly and discarded:

- **Dune / Flipside SQL queries.** Requires writing tax classification
  logic in SQL; Sui coverage on Dune is uncertain; debugging SQL
  pipelines for edge cases is worse than TypeScript.
- **LLM-assisted classifier.** Non-deterministic. Unsuitable for
  tax-grade work.
- **Koinly API as decoder.** Koinly's decoders are exactly what Felix
  said is broken. Tautological failure.
- **Greenfield React + in-browser app.** Conflicts with "strip away
  everything else including UI." React is not the problem; premature
  UI commitment is.
- **Forking `raccoin` (Rust + Slint).** Stale (last release Jan 2024),
  GPL-3.0 (fork pollution), no DeFi decoding. Not viable.
- **Forking `rp2` + writing DaLI plugins.** `rp2` is US-Form-8949-focused;
  German §23 is not built in. `dali-rp2` plugin coverage for DeFi
  protocols Felix cares about is thin. You'd be writing the same
  decoders from scratch but in Python and constrained by `rp2`'s data
  model. No advantage.

---

## 5. Prior-Art Research (Pass 2 — Open-Source Libraries)

After the three options were presented, Felix asked for a dedicated
research pass on existing open-source projects that already export tax
CSVs from on-chain activity. This section captures what was found and
how it informed the final recommendation.

### 5.1 `staketaxcsv` — [hodgerpodger/staketaxcsv](https://github.com/hodgerpodger/staketaxcsv) ★ *must read*

- **Language:** Python 3.9+
- **License:** MIT
- **Stars:** ~268
- **Maintenance:** Active (it powers the free stake.tax website)
- **Chains:** Akash, Algorand, Archway, Cosmos, Agoric, and others, plus
  **Solana (SOL)**.
- **Output formats:** Koinly, CoinTracking, and others via a shared CSV
  exporter.

#### Why it matters

This is the closest existing open-source work to what Felix is building.
It proves the pattern: per-chain CLI entry point (`report_sol.py`) →
per-protocol handlers (`handle_orca.py`, `handle_raydium_lp.py`,
`handle_jupiter.py`) → canonical row format → multiple export writers.
**The architecture is directly transferable to TypeScript.**

#### Solana protocol coverage (verified by directory listing)

- Jupiter (swap, airdrop, DCA, limit orders, perpetuals)
- Marinade (liquid staking)
- **Orca** (`handle_orca.py` exists)
- Raydium (LP + staking, separate files)
- Saber
- Serum v3
- Wormhole
- Metaplex / generic NFT markets

#### Critical caveat on Orca

A single `handle_orca.py` file with no separate Whirlpool module
strongly suggests this predates Whirlpools CLMM — probably handles
classic constant-product Orca pools only. **You should read the file to
confirm before copying any patterns**, but do not assume Whirlpool
position NFTs, fee harvests, or rebalances are decoded to tax-grade
detail there. This is exactly the gap Felix's tool fills.

#### What to read from this repo

1. `src/staketaxcsv/sol/handle_orca.py` — dispatch pattern, at minimum.
   If it covers Whirlpools at all, steal it directly. If not, note
   what's missing and why.
2. `src/staketaxcsv/sol/make_tx.py` (or equivalent) — their canonical
   transaction schema. Compare to your `Event` type; adopt what's better.
3. `src/staketaxcsv/common/Exporter.py` or the Koinly exporter — **steal
   the CSV column layout verbatim**. Do not rediscover Koinly's format.
4. `src/staketaxcsv/sol/handle_jupiter.py` — good example of a complex
   multi-instruction handler.
5. Top-level `report_sol.py` — ingest loop structure.

### 5.2 `rp2` + `dali-rp2` — [eprbell/rp2](https://github.com/eprbell/rp2), [eprbell/dali-rp2](https://github.com/eprbell/dali-rp2)

- **Language:** Python
- **License:** Apache-2.0
- **Maintenance:** Active, well-documented
- **Architecture:** Clean split — `rp2` is the tax engine (FIFO / LIFO /
  HIFO, US Form 8949), `dali-rp2` is the data loader with a plugin
  architecture (both CSV and REST plugins).

#### Why it matters

- Reference **plugin architecture** for data loaders. If Felix ever
  wants to make his decoders pluggable (e.g., "add a new protocol
  without touching core"), dali-rp2's plugin pattern is worth studying.
- `rp2`'s in/out lot fractioning algorithm is the gold standard
  implementation of capital gains math. If Phase 3 adds a tax engine,
  rp2's approach is what to copy.

#### Why it's not a fork target

- US-focused (Form 8949). German §23 would be a substantial addition.
- Plugin coverage for the protocols Felix cares about (Orca CLMM, Navi,
  Suilend) does not exist. He'd be writing everything anyway, but in
  Python and inside rp2's conventions.

### 5.3 `perfi` — [AUGMXNT/perfi](https://github.com/AUGMXNT/perfi)

- **Language:** Python, alpha
- **Chains:** "Some EVM chains" (not specified)
- **Architecture:** DeBank OpenAPI for transaction retrieval + custom
  per-protocol rules for classification
- **Output:** US Form 8949-style XLSX, HIFO lot matching

#### Why it's interesting

The project explicitly states it was built because "no existing tool
could understand DeFi." That diagnosis matches Felix's. Reading their
rules layer might reveal which edge cases they ran into.

#### Why it's not a fork target

- Alpha, not actively maintained.
- Author's own disclaimer: results "almost guaranteed to be incorrect
  without manual adjustments." Telling about the difficulty of the
  problem — not reassuring about the code.
- EVM-only. No Solana, no Sui.
- Tightly coupled to DeBank API.

### 5.4 `raccoin` — [bjorn/raccoin](https://github.com/bjorn/raccoin)

- **Language:** Rust + Slint UI
- **License:** GPL-3.0 (viral — affects any fork)
- **Currency / method:** EUR / FIFO
- **Chains:** Direct sync for Bitcoin, Ethereum, Stellar. CSV import
  from 24+ exchanges.
- **Maintenance:** Stale (last release v0.2, January 2024)

#### Why it caught attention

The only EUR + FIFO tool found in the search. Closest to Germany-
friendly defaults.

#### Why it's not a fork target

- Stale.
- GPL-3.0 makes forking contagious.
- No DeFi decoding, no Base, no Solana, no Sui.
- Rust is a new dependency to take on for a solo project where every
  other target SDK is TypeScript.

### 5.5 `BittyTax` — [BittyTax/BittyTax](https://github.com/BittyTax/BittyTax)

- **Language:** Python
- **Maintenance:** Active
- **Jurisdiction:** UK-focused
- **Coverage:** Wallets, exchanges, explorers; handles DeFi *loans* via
  a manual-tx augmentation pattern (you record synthetic disposals for
  both lending and repayment legs).

#### Why it matters

The **loan / lending modeling pattern** is the most directly relevant
feature. For Navi and Suilend positions, Felix will need to decide: does
a borrow create a tax event? Does repaying it? BittyTax has a concrete
answer implemented (for UK rules) that can be read as reference.

#### Why it's not a fork target

- UK-focused (Share Pooling, not FIFO + Haltefrist).
- Heavy CeFi emphasis, light on-chain decoding.

### 5.6 `uni-v3-position-tracker` — [ncitron/uni-v3-position-tracker](https://github.com/ncitron/uni-v3-position-tracker)

- **Scope:** Narrow — extracts historical Uniswap V3 positions to CSV.
- **Source:** The Graph subgraph (requires a Graph API key).

#### Why it matters

Template for "use an indexed subgraph instead of raw RPC + SDK." For
Uniswap V3 and Aerodrome slipstream on Base, subgraphs exist and can
dramatically simplify the ingest side — you query GraphQL, get decoded
events, skip the SDK entirely.

**Worth considering as an ingest strategy for Base** if viem-based
decoding proves too painful. Filed for later; does not change the MVP
direction.

### 5.7 Honorable mentions (not deeply evaluated)

- **[orca-so/whirlpools](https://github.com/orca-so/whirlpools)** —
  official Orca SDK monorepo. Required reading for the Whirlpool
  decoder.
- **[naviprotocol/navi-sdk](https://github.com/naviprotocol/navi-sdk)** —
  official Navi SDK. Required reading for the Navi decoder.
- **Rotki's Aerodrome decoder** (`rotki/chain/evm/decoding/aerodrome/`).
  Python, but reading it will tell you exactly what event shapes
  Aerodrome emits and how to classify them. Free reference material.
- **Revert Finance (closed source)** — commercial LP analytics. Good
  reference for what "great UX for LP positions" looks like, if a UI
  is ever added in Phase 2.

### 5.8 What Pass 2 changed

Three concrete updates to the decision:

1. **The per-protocol-handler pattern is universal.** Every mature tool
   in the space uses it. Option 1's design is not unusual — it is
   exactly the standard. This **reinforces the recommendation** and
   weakens Option 3-as-primary.

2. **No one has tax-grade Orca CLMM, Navi looping, Turbos, or Suilend
   decoders in open source.** The gap is real. This confirms Felix's
   premise about the market failure and **permanently rejects Option 2**
   (Rotki hybrid) — Rotki inherits the same gap.

3. **staketaxcsv is free reference material that should be read before
   writing code.** Even though it's Python and doesn't cover Felix's
   exact scope, its architecture, Koinly exporter, and Orca handler are
   direct references.

---

## 6. Final Recommendation

**Option 1 (custom TypeScript decoder) with an Option 3 fallback layer.**

### 6.1 Concrete design

Per-protocol handlers in TypeScript, built on official SDKs (`@orca-so/
whirlpools-sdk`, `@mysten/sui`, `navi-sdk`, `turbos-sdk`, `@suilend/sdk`,
viem for Base). Storage is local SQLite. The pipeline is idempotent and
re-runnable.

Any transaction that no handler recognizes goes into an `unclassified`
table, where a small Ink-based TUI lets Felix label it manually. Labels
become rules (for simple cases) or trigger new handler development (for
complex cases).

Export target is Koinly's custom CSV format, with column layout adopted
directly from `staketaxcsv`'s Koinly exporter.

### 6.2 Why this wins

- **Research-backed.** Matches the architecture of every mature tool in
  the space. Reuses staketaxcsv's reference patterns.
- **Protocol alignment.** Every target SDK is TypeScript-native. Same
  language end to end.
- **Scope-appropriate.** Strips out the tax engine, UI, and
  multi-tenancy that bloat existing solutions without adding value for
  Felix's use case.
- **German §23 deferral.** Emits clean CSV; Koinly handles the math
  until Phase 3 (if ever).
- **Robustness via fallback.** The `unclassified` table + TUI ensures
  the pipeline never silently drops data, even for protocols that don't
  yet have a handler.

### 6.3 Why Options 2 and 3 lose

- **Option 2** (Rotki hybrid) fails on the Orca CLMM gap. Rotki's
  Solana coverage does not extend to Whirlpool CLMM position NFTs, so
  the scenario where Rotki carries the load for 2/3 chains while Felix
  only writes Sui *does not materialize*. The practical outcome is
  that Felix patches Python decoders for the chain (Solana) where he
  most needs decoding help — strictly worse than writing them in
  TypeScript from scratch.
- **Option 3** (pure firehose) discards the free leverage of official
  SDKs and staketaxcsv reference code. For Felix's specific target
  protocols, writing a handler is not harder than hand-labeling and
  produces a reusable, testable artifact. Promoted to fallback layer.

### 6.4 Honest uncertainty

The **Sui decoder effort** is the biggest unknown. No one has done this
work in open source. Navi and Turbos SDKs exist and are well-documented,
but their event shapes need to be inspected against Felix's actual
on-chain history before any confident time estimate can be given.

**Pre-plan spike recommended:** one day, clone `navi-sdk`, query Felix's
Sui wallet, inspect one looping position's event log end to end. If
painful, revisit Option 3 as primary for Sui (hand-label Sui;
handler-decode Base + Solana). If tractable, proceed with Option 1
uniformly.

---

## 7. Minimum Viable Product

### 7.1 `Now` scope

1. New subfolder in this repo (`tools/tax-decoder/`) or a new sibling
   repo — Felix's choice during `/plan`.
2. Config with hardcoded wallet addresses per chain.
3. Ingest adapters:
   - Base (viem + public RPC or Alchemy free tier)
   - Solana (Helius free tier → escalate to Developer $49/mo if needed)
   - Sui (public Sui RPC)
4. SQLite schema:
   - `raw_txs` — one row per on-chain tx, full JSON blob
   - `events` — canonical `Event` rows (see 4.1)
   - `rules` — fingerprint → classification, for firehose fallback
   - `prices` — (asset, timestamp) → usd, cached
   - `unclassified` — raw txs no handler matched, awaiting TUI
5. Protocol handlers:
   - Aerodrome slipstream (Base)
   - Uniswap V3 (Base) — NonfungiblePositionManager; mature subgraph; `uni-v3-position-tracker` as template
   - Aave V3 (Base) — Supply/Withdraw/Borrow/Repay/LiquidationCall events; Rotki's Aave decoder as reference
   - Orca Whirlpool (Solana)
   - Turbos CLMM (Sui)
   - Navi lending + looping (Sui)
   - Suilend (Sui)
6. CoinGecko price cache, aggressive backoff.
7. Ink-based TUI for `unclassified` table.
8. Koinly CSV exporter (column layout lifted from staketaxcsv).
9. Golden-fixture test suite: ~20 hand-labeled historical txs from
   Felix's actual wallets.

**Build one chain end-to-end before breadth.** Recommended order: Base →
Solana → Sui. Base is the fastest to prove the architecture; Sui is the
riskiest and should land on a tested foundation.

### 7.2 `Later` scope (deferred)

- React UI / browser dashboard (maybe Tauri, maybe sql.js, maybe
  nothing).
- Tax engine — FIFO + German §23 Haltefrist, reading from the same
  SQLite.
- Additional chains (Aptos, Hyperliquid, whatever else) or protocols
  Felix starts using.
- Upstreaming Sui decoders to staketaxcsv or similar, if maintainers
  want them.
- Live price streaming (current design backfills; near-real-time is a
  separate problem).

### 7.3 `Out` of scope (excluded)

- Multi-user support, authentication, hosted deployment.
- Wallet-connect UX — addresses are hardcoded.
- Tax forms for jurisdictions other than Germany.
- Portfolio dashboard features beyond what a `SELECT` on the events
  table gives you.
- Anything that requires a server.

**If implementation discovers work outside these boundaries, STOP and
ask — do not silently expand scope.**

---

## 8. Top Risks and Mitigations

Carried forward from Checkpoint 4 of the exploration, ranked by combined
likelihood × blast radius.

1. **Sui decoder complexity (unknown)** — no prior art exists. Biggest
   unknown in the project.
   - *Mitigation:* One-day spike on Suilend before committing. If
     blocked, reconsider Option 3 as primary for Sui.
2. **Orca Whirlpool fee vs principal disambiguation on rebalances** —
   transfers alone don't always disambiguate.
   - *Mitigation:* Use `@orca-so/whirlpools-sdk` to read position state
     before and after each tx; compute the delta. Read
     `staketaxcsv/sol/handle_orca.py` first to see how they handled
     classic pools.
3. **CoinGecko rate limits on initial backfill** — first run against
   years of history will hit 10k calls/month.
   - *Mitigation:* Cache prices aggressively and deduplicate aggressively;
     CoinGecko returns daily prices for historical queries so backfill
     needs are smaller than they look; run backfill in chunks across
     multiple days if needed.
4. **Scope creep from Felix himself** — the most common failure mode
   for solo side projects.
   - *Mitigation:* `docs/scope.md` checked into the repo with the
     `Now / Later / Out` lists. Any PR or commit that crosses a
     boundary gets rejected by a pre-commit hook or a rule in
     `CLAUDE.md`.
5. **Test data realism** — you can't invent edge cases, you have to
   find them.
   - *Mitigation:* On day one, dump all Felix's historical transactions
     to JSON fixtures. Hand-label ~20 of the gnarliest ones. Make them
     the test corpus for every handler.
6. **Looping tax policy is a human decision** — German §23 has no
   definitive answer for "is the re-stake of borrowed SUI a disposal?"
   - *Mitigation:* Make the call explicit, encode it as a rule, document
     it in `docs/tax-policy.md`, apply consistently. Revisit if a
     Steuerberater disagrees.
7. **Protocol upgrades break handlers silently** — Turbos V2 changes
   event shapes, your handler returns zero events.
   - *Mitigation:* Fail loud on unknown event shapes, not silent. Every
     handler has a whitelist of known module addresses / contract
     addresses; unknown ones route to `unclassified` automatically.

---

## 9. Reference Code Reading List

Read these before writing any handler code. They are *not* dependencies
to import — they are reference material.

| Repo | File(s) | Why |
|---|---|---|
| `hodgerpodger/staketaxcsv` | `src/staketaxcsv/sol/handle_orca.py` | Closest prior art for Orca classification |
| `hodgerpodger/staketaxcsv` | `src/staketaxcsv/sol/handle_jupiter.py` | Good example of a complex multi-instruction handler |
| `hodgerpodger/staketaxcsv` | `src/staketaxcsv/common/Exporter.py` (or equivalent) | Koinly column layout — copy it |
| `hodgerpodger/staketaxcsv` | `src/staketaxcsv/sol/make_tx.py` (or equivalent) | Canonical row schema to compare against ours |
| `rotki/rotki` | `rotkehlchen/chain/evm/decoders/aerodrome/` | Free reference for Aerodrome event shapes |
| `rotki/rotki` | `rotkehlchen/chain/evm/decoders/uniswap/v3/` | Free reference for Uniswap V3 event shapes |
| `orca-so/whirlpools` | `sdk/src/impl/position-impl.ts` and tick math | Official fee / position math |
| `naviprotocol/navi-sdk` | README + examples | Navi event shapes, health factor queries |
| `BittyTax/BittyTax` | DeFi-loans handling documentation | UK loan modeling — reference for the "what's a tax event on a borrow?" question |
| `eprbell/rp2` | `rp2/in_out_pair.py` (or equivalent) | Gold-standard FIFO/HIFO lot-matching algorithm (for Phase 3 tax engine) |

---

## 10. Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-11 | Tax tracking, not portfolio | Felix clarified primary goal |
| 2026-04-11 | Solo-use, self-hosted | Felix confirmed — eliminates auth/hosting/multi-tenancy |
| 2026-04-11 | Germany (§23 EStG) | Felix confirmed jurisdiction |
| 2026-04-11 | Sui scope: Turbos + Navi + Suilend only | Felix confirmed — Cetus / Bluefin dropped |
| 2026-04-11 | CSV export, not tax engine | Classification is the hard part; downstream tools handle math over a clean CSV |
| 2026-04-11 | Rotki fork rejected | Option 2 analysis — Orca CLMM gap collapses the value proposition |
| 2026-04-11 | Pure firehose rejected as primary | Option 3 analysis — SDKs and staketaxcsv reference make handlers more efficient than manual labeling for common case |
| 2026-04-11 | Firehose promoted to fallback | Needed to handle unknown txs without silent data loss |
| 2026-04-11 | TypeScript, not Python | Every target SDK is TypeScript-native |
| 2026-04-11 | SQLite as source of truth | Idempotent, re-runnable, Phase-2/3 friendly |
| 2026-04-11 | No React UI in MVP | Premature commitment; Phase 2 if needed |

---

## 11. Open Questions for `/plan`

1. **Repo location:** new subfolder `tools/tax-decoder/` within
   `liquidity-sheets`, or new sibling repo `liquidity-tax`? Leaning
   toward sibling repo because the existing sheets workflow and the
   new TypeScript project have no runtime overlap.
2. **Sui spike first, or plan first?** A one-day Suilend spike before
   `/plan` would reduce the biggest unknown. Alternatively, plan can
   schedule the spike as Task 1.
3. **Ink vs Inquirer for TUI?** Ink is React-for-CLI (familiar mental
   model); Inquirer is simpler and enough for a prompt-driven
   labeller. Defer to `/plan`.
4. **Test fixtures — how many txs to hand-label for the corpus?** 20 is
   the heuristic, but the actual number depends on how many distinct
   protocol interactions Felix has in history. Count during ingest
   before committing.
5. **Price source priority:** CoinGecko first, DefiLlama fallback, or
   both in parallel with disagreement-flagging? Tax correctness may
   justify the latter; simplicity favors the former.

---

## 12. Next Action

**Recommended:** run `/plan` with this document as input. The plan
should:

1. Schedule a one-day Sui spike as its first task.
2. Sequence Base → Solana → Sui implementation in that order.
3. Map out the concrete file tree, SQLite schema, and canonical event
   type as first-class artifacts.
4. Identify the specific staketaxcsv and Rotki files to read before
   each handler is written.
5. Establish the hand-labeled test fixture as a precondition for each
   handler's "done" state.

**Alternative:** run a manual exploration sprint first — clone
staketaxcsv, read `handle_orca.py`, clone `navi-sdk`, query one Sui
position — then return for `/plan` with empirical answers to the open
questions.

---

*End of document.*
