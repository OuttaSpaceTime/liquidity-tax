# Architecture Critique — Tax Decoder Planning Docs

**Date:** 2026-04-18
**Inputs audited:** `.claude/docs/explorations/001-tax-decoder-research-20260411.md`, `.claude/docs/repo-analysis/_synthesis.md`, `_overview.md`, per-chain notes, and individual repo analyses.
**Status:** Planning phase. No code written.

---

## Architectural verdict: **good-to-go, with two unresolved tensions**

The overall shape is sound. The consensus pipeline (ingest → decode via per-protocol handlers → export to Koinly CSV) mirrors every mature tool in the space (rotki, staketaxcsv, perfi). SQLite as the idempotent persistence layer is the right call. Per-protocol handlers in TypeScript are the right pattern — every target SDK is TypeScript-native.

Two tensions must be resolved before Phase 0 ends:

1. **The three-phase dispatch pattern is claimed but not fully specified.** The synthesis references rotki's approach (address-specific → generic → post-decode aggregation), but the concrete `Handler` TypeScript interface and registry binding mechanism are not written down. How do new handlers register — decorator, explicit class-level registry, filesystem convention? This is a load-bearing decision that cascades to every subsequent handler.

2. **The `TaxEvent` type conflates two concerns.** `positionId` and `walletAddress` are protocol-agnostic and well-justified. But `extraData` is an escape hatch — a hedge against incomplete understanding. For Sui, the haSUI loop detection requires state tracked across multiple events in a single tx; this is poorly served by an opaque `extraData` dict.

Neither blocks the MVP. Both are implementable during Phase 0 scaffolding.

---

## Plug-in adapter assessment

### Strengths

- **Address/program-ID dispatch is clean across all three chains.** EVM contracts (Aave Pool, Uniswap V3 NPM), Solana program IDs (Whirlpool), Sui Move package IDs (Turbos) — all routable by one dispatch mechanism.
- **Handlers leverage real official SDKs**, not reverse-engineered ABIs. Whirlpool IDL from `@orca-so/whirlpools-sdk`, Aave addresses from `@bgd-labs/aave-address-book`, Turbos call targets from `turbos-clmm-sdk`.
- **Fallback TUI for unclassified txs** prevents silent data loss. Anything unmatched hits the `unclassified` table.

### Weaknesses

- **Aerodrome "inherits from Uniswap V3" is assumed but without a formalized base class.** Rotki's precedent is 51 lines on a 569-line Velodrome base. Our docs don't say: will there be a `UniswapV3LikeHandler` base class, or copy-paste sharing? Slipstream's gauge rewards differ from vanilla V3; tight coupling will break.
- **Position lifecycle tracking is novel and loosely specified.** Open questions:
  - How do `positionId` values get assigned for protocols without NFTs? (Whirlpool NFTs are explicit; Navi obligations are implicit object IDs; Suilend has no NFT at all.)
  - Is position state persisted in the decoder, or only in SQLite?
  - Is `positionId` nullable for non-CLMM events? The synthesis says yes but the Koinly-grouping behavior isn't specified.
- **Solana CPI depth tracking is mentioned in `_notes-solana.md` but absent from the canonical `TaxEvent` schema.** Distinguishing a user-initiated `collectFees` (depth=0) from a rebalance-embedded `collectFees` (depth=1) affects tax classification. Will `callIndex` / `depth` live in `extraData`?

### Verdict

Plug-ins will work cleanly for simple protocols (Aave V3). CLMM handlers (Whirlpool, Turbos, Suilend) will expose gaps in the base abstractions around position identity and lifecycle. Mitigate by building the simpler handlers first (Uniswap V3, Aave V3), then refining the base class when CLMM lands.

---

## Top 5 gaps (ranked)

### 1. Handler interface and registry binding are unspecified

The most important pre-code deliverable. Study rotki's `DecodeResult decode(...)` and staketaxcsv's self-registering pattern, pick one, write the TypeScript interface down before any handler is written. **Est: 1–2 hours.**

### 2. The (type, subtype) valid-pairs matrix is acknowledged but not enumerated

Synthesis defers this to `/plan` but the exporter depends on it. How does `(lp_fee, collect)` map to a Koinly label? Rotki validates ~150 of ~800 theoretical pairs. We need our own table before the exporter is built. **Blocker if Koinly rejects the chosen label** — should be tested empirically in Phase 1D.

### 3. Cross-chain transfer linking is sketched but not detailed

30-min time window is proposed but disambiguation (multiple transfers in the same window) is undefined. `transfer_links` table not integrated into `TaxEvent` schema or the future FIFO engine. **Non-blocking for MVP** (deferred to Phase 3) but the table should be designed now so Phase 1 data can be repaired later.

### 4. Sui decoder effort is underestimated in the exploration doc

The 2026-04-11 exploration listed Sui as "unknown, Risk 1" with a one-day spike. The synthesis refined it upward: Turbos 1d + Navi 1.5d + Suilend 1d + haSUI 0.5d = 4 days minimum. Navi specifically (not Suilend) is the canary — its event schemas require bytecode disassembly. **Recommend: spike Navi first, not Suilend.**

### 5. ethers v5 + viem dual-provider isolation hazard

`aave-utilities` requires ethers v5; rest of Base is viem. Risk 8 in synthesis proposes an isolated `aave/positions.ts` module. Needs a Phase 0 smoke test: call viem's `getBlock()` and ethers-wrapped `UiPoolDataProvider.getUserReservesHumanized()` against the same RPC, confirm no collision, document the pattern.

---

## Must-decide-before-coding list

1. **Handler interface and registry pattern.** Decorator + auto-discovery, explicit registry, or filesystem convention?
2. **Position ID canonical format.** Proposed: `{chain}:{protocol}:{id}` (e.g., `solana:orca-whirlpool:{nftMint}`, `sui:navi:{obligationObjectId}`).
3. **Koinly label mapping for CLMM events.** Test exports with candidate labels for `lp_fee` and `lp_reward`; document in `config/koinly-labels.ts`.
4. **Repository location and package boundaries.** Sibling repo or subfolder? Monorepo or separate packages?
5. **Config format.** TypeScript config (`config/wallets.ts`) + `.env` for RPC endpoints recommended.
6. **Test-first discipline.** Per global CLAUDE.md: tests before code. Proposal: dump history in Phase 0, hand-label ~20 txs as corpus, each handler's "done" = passes ≥3 fixtures.
7. **Secrets handling.** Env vars (recommended), config file (risky), or interactive prompt?
8. **Haltefrist parameterization.** Even though Phase 1 has no tax engine, store the 1-year constant as config now.

---

## Estimates reality check

Exploration doc section 7.1: **MVP Phase 1 = 12–17 days.** Synthesis breakdown confirms internal consistency.

Reality adjustments:

- **Phase 1C (Sui) should be buffered to 5 days.** The Navi spike dominates uncertainty; if sui-events-indexer hits friction, 1C balloons to 5–6d.
- **Phase 1A (Base) is the fast path.** Realistic: day 1 ingest + V3 handler, day 2 Aave, day 3 Aerodrome + export, day 4 buffer. 3–4d is sound.
- **Solana CPI flattening is not a risk** — `solana-tx-parser-public` ships it.

Total realistic range: **13–18 days** (12–17 minus optimism plus Sui buffer).

---

## Scope/risk gaps not yet addressed

1. **Gas fee accounting** is absent from the docs. Koinly accepts gas as a separate line item. Needs a Phase 1 decision.
2. **Bridges** (Wormhole Base↔Solana) are referenced as "cross-chain linking" but not scoped.
3. **Reward accrual vs materialization** — current design is claim-time only (correct for Koinly). Should be explicit in docs.
4. **Multiple wallets per chain** are noted but the `walletAddress` field is singular; transfers between own wallets need explicit grouping logic.
5. **Aerodrome gauge staking** is a distinct tx from LP deposit; needs to be called out in Phase 1A sub-scope.
6. **Liquidations** — Aave, Navi, Suilend can all be liquidated. The subtype exists; the mapping is not documented.
7. **Flash loans** — explicitly in scope or out? Aave has them; Felix may not use them. Document either way.

---

## Recommendations

**Green lights:**
- Three-phase dispatch, SQLite persistence, per-protocol handlers — proven and sound.
- TypeScript end-to-end — correct for the SDK ecosystem.
- Koinly CSV export as MVP finish line — right scope.

**Yellow flags requiring pre-code decisions:**
- Handler interface must be written before Phase 0 ends.
- Koinly label mapping needs empirical test.
- Sui spike should target Navi specifically, not Suilend.
- Aerodrome gauge rewards should be explicit Phase 1A sub-scope.

**Red flags to monitor during build:**
- CLMM handlers will stress the position lifecycle abstraction — be ready to refactor after the first Whirlpool handler.
- ethers v5 + viem isolation must be tested in Phase 0.
- Design `transfer_links` table now; Phase 3 will need it, Phase 1 data must be repairable.

**No architectural blockers. Project is ready for `/plan`.**
