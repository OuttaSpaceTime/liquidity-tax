# Accounts, API Keys, and Initial Issues Draft

**Date:** 2026-04-18
**Status:** Planning phase. Coding has not started. No repo created yet.

---

## Accounts & API keys checklist

| Service | Why needed | Free tier sufficient? | Signup URL | Blocked without? | Notes |
|---|---|---|---|---|---|
| Helius | Solana RPC + enhanced tx for ingest | Yes (1M credits/mo free); escalate to $49/mo Developer if backfill hits ceiling | https://www.helius.dev | Yes | ~10k enhanced-tx calls/mo on free tier. Cache aggressively. |
| Alchemy | Base RPC | Yes (300k daily calls free) | https://www.alchemy.com | No | QuickNode works too; Alchemy has better docs. |
| Sui public RPC | Sui tx history | Yes | `https://fullnode.mainnet.sui.io` | No | Shinami/BlockVision only if rate limits hit during backfill. |
| CoinGecko Demo | Historical USD pricing | Yes (10k calls/mo, 12 yr history) | https://www.coingecko.com/en/api | Yes | Daily granularity; aggressive SQLite cache. |
| DefiLlama coins | Pricing fallback for long-tail tokens | Yes (no auth required) | https://defillama.com/docs | No | Secondary source; no account needed. |
| Koinly | CSV import testing target | Yes (free tier allows import) | https://www.koinly.io | Yes | **Day-1 signup** — must test the CSV export + label mapping empirically. |
| GitHub | Repo + issue tracker | Yes | https://github.com | Yes | Use existing account. |
| The Graph | Uniswap V3 subgraph (optional) | Decentralized queries need GRT; hosted deprecated | https://thegraph.com | No | **Defer.** viem + RPC is sufficient for MVP. |
| GoldRush / Covalent | Base cross-check (optional) | Yes (100k credits/mo) | https://goldrush.dev | No | **Defer.** Optional only. |

**Day-1 must-have:** Helius · Alchemy · CoinGecko Demo · Koinly · GitHub repo.
**Can defer:** Sui paid RPC · DefiLlama (no signup) · The Graph · GoldRush.
**Budget floor:** $0/mo initially → **~$49/mo** if Helius free tier proves tight during backfill.

---

## Initial issues draft (18 issues)

### Phase 0: Bootstrap (~1 day)

**[0.1] Create repo scaffolding & SQLite schema**
- Labels: `phase-0`, `infra`
- TypeScript project (tsconfig, ESLint, Prettier). **Stack: `better-sqlite3` + `drizzle-orm` + `drizzle-kit` for migrations.** Schema defined in `db/schema.ts` as Drizzle tables (not raw SQL) so `TaxEvent` types flow end-to-end and agent-authored queries are compile-checked. Tables: `raw_txs`, `events`, `positions`, `prices`, `unclassified`, `rules`, `transfer_links`. Migrations generated via `drizzle-kit generate` → `db/migrations/NNNN_*.sql`. JSON columns typed via `.$type<T>()`. BigInt columns use `mode: 'bigint'`. Wallet-address config in `config/wallets.ts`. Copy Koinly CSV column layout from `staketaxcsv/common/ExporterTypes.py:386-412`.
- Done when: `src/`, `db/schema.ts`, `config/wallets.ts`, `.env.example` exist; `npm run build` succeeds; `drizzle-kit generate` produces a clean initial migration; schema matches `_synthesis.md`.
- Depends on: —
- **2026-04-19 decision:** Chose Drizzle over raw SQL (rotki/perfi pattern) despite the prior-art survey recommending raw SQL. Reason: agent-assisted development benefits from typed schema + autocomplete far more than a solo human would; the productivity delta for AI-authored code outweighs the "minimalism" ethos. No `CASCADE` on `raw_txs → events` — hand-labeled data must survive re-ingests.

**[0.2] Define canonical `TaxEvent` type + valid type×subtype matrix**
- Labels: `phase-0`, `schema`, `decoder-core`
- Implement `interface TaxEvent` from `_synthesis.md`. Enumerate ~150 valid `(type, subtype)` pairs rotki-style. Compile-time rejection of invalid pairs.
- Done when: `src/types/event.ts` compiles; invalid pair (e.g. `{type: 'transfer', subtype: 'lp_fee'}`) fails type check; valid-pairs table inline-documented.
- Depends on: [0.1]

**[0.3] Define `Handler` interface, registry, and three-phase dispatch skeleton**
- Labels: `phase-0`, `decoder-core`, `infra`
- Formalize the plug-in contract. `DecoderRegistry` with O(1) address-specific dispatch, generic rules phase, post-decode aggregation phase. Unclassified fallback route. All handlers stub out at this point.
- Done when: `Handler` interface exported; registry registers + dispatches; unmatched txs land in `unclassified`; no handlers have logic.
- Depends on: [0.2]

### Phase 1A: Base (EVM) end-to-end (~3–4 days)

**[1A.1] Base ingest adapter (viem)**
- Labels: `phase-1a-base`, `infra`
- viem `getLogs()` per protocol contract (Uniswap V3 NPM, Aerodrome Slipstream NPM, Aave Pool). Store raw receipts keyed by `(chain, tx_hash)`. Idempotent.
- Done when: `src/chains/base/ingest.ts`; rerun skips fetched txs; ≥10 sample txs in DB.
- Depends on: [0.1]

**[1A.2] Koinly CSV exporter**
- Labels: `phase-1a-base`, `export`
- Map `TaxEvent` rows to Koinly's 12-column CSV. `(type, subtype)` → Koinly label mapping (seed from staketaxcsv `Exporter.py:940-964`).
- Done when: `src/export/koinly-csv.ts` exists; column order matches staketaxcsv exactly; test CSV imports into Koinly without parse errors.
- Depends on: [0.2]

**[1A.3] Uniswap V3 handler (Base)**
- Labels: `phase-1a-base`, `handler`
- Decode `IncreaseLiquidity` / `DecreaseLiquidity` / `Collect` on `NonfungiblePositionManager`. Pair with ERC-20 `Transfer` logs. Emit `lp_deposit`, `lp_withdraw`, `lp_fee`. Position tokenId → `positionId`.
- Done when: 5 real Uni V3 txs decode; fee amounts separated from principal; rotki V3 decoder referenced for edge cases.
- Depends on: [1A.1], [0.3]

**[1A.4] Aerodrome handler (Base, extends Uni V3)**
- Labels: `phase-1a-base`, `handler`
- Extend V3 handler. Add gauge-reward events (AERO emissions) as `lp_reward` (distinct from `lp_fee`). Reference rotki's `AerodromeDecoder` inheriting `VelodromeLikeDecoder`.
- Done when: Slipstream events decode; AERO rewards labeled `lp_reward`; shared base class extracted.
- Depends on: [1A.3]

**[1A.5] Aave V3 handler (Base, viem-native via `@aave/client`)**
- Labels: `phase-1a-base`, `handler`
- Decode `Supply` / `Withdraw` / `Borrow` / `Repay` / `LiquidationCall`. Use **`@aave/client` (AaveKit TypeScript)** — viem-first successor to the deprecated `aave-utilities`; no ethers v5 quarantine needed. Compute interest from scaled-balance deltas in event data (RAY 1e27 fixed-point); fall back to hand-rolled math if `@aave/client` lacks historical reads. Addresses via `@bgd-labs/aave-address-book`.
- Done when: 5 Base Aave txs decode; no ethers dependency anywhere in the tree.
- Depends on: [1A.1], [0.3]
- **2026-04-19 research update:** aave-utilities is the deprecated path (ethers.js). Canonical modern SDK is `@aave/client`, modeled on viem's actions architecture, supports viem/ethers v6/Privy/thirdweb/Turnkey. This removes doc 01 gap #5 (viem+ethers dual-provider hazard) from scope.

**[1A.6] Base golden-fixture tests**
- Labels: `phase-1a-base`, `test-fixtures`
- Dump Base history → JSON fixtures. Hand-label ~5 gnarly txs (V3 rebalance, Aerodrome+rewards, Aave supply+reward). All 3 handlers must pass.
- Done when: `tests/fixtures/base-golden.json`; all handlers pass; Koinly accepts the CSV output.
- Depends on: [1A.3], [1A.4], [1A.5]

### Phase 1B: Solana end-to-end (~3–4 days)

**[1B.0] Decide Solana stack: Web3.js v1 vs v2** *(new, from doc 04)*
- Labels: `phase-1b-solana`, `infra`, `risk`
- The legacy `@orca-so/whirlpools-sdk` is sunsetted; new canonical is `@orca-so/whirlpools` (v7.x) + `@orca-so/whirlpools-core`, which requires **Solana Web3.js v2 / `@solana/kit`**. `solana-tx-parser-public` targets Web3.js v1. Decide: adopt v2 end-to-end (recommended — future-proof, kills the Anchor 0.31/0.32 concern) or stay on v1 with legacy SDK and accept a later port.
- Done when: decision documented in `docs/adr/001-solana-stack.md`; dependencies pinned in `package.json`.
- Depends on: [0.1]

**[1B.1] Solana ingest adapter (Helius)**
- Labels: `phase-1b-solana`, `infra`
- `getSignaturesForAddress` + `getTransaction` via Helius. `flattenTransactionResponse` from `solana-tx-parser-public`. Idempotent by signature.
- Done when: `src/chains/solana/ingest.ts`; rerun skips fetched txs; sample Whirlpool txs flattened.
- Depends on: [0.1]

**[1B.2] Position lifecycle tracker (shared CLMM infra)**
- Labels: `phase-1b-solana`, `decoder-core`
- State machine: `open` → `add`/`remove` → `harvest` → `close`. `positions` SQLite table keyed by `positionId`. Used by Whirlpool, Turbos, Uni V3.
- Done when: A Whirlpool position can be tracked open-to-close; lifecycle events linked via `positionId`.
- Depends on: [0.2]

**[1B.3] Orca Whirlpool handler**
- Labels: `phase-1b-solana`, `handler`
- Classify Whirlpool instructions (OpenPosition, IncreaseLiquidity, DecreaseLiquidity, CollectFees/V2, CollectRewards, ClosePosition). Pair with SPL `transferChecked` CPI children. Position NFT mint → `positionId`. Use **`@orca-so/whirlpools`** (new SDK, v7.x) + `@orca-so/whirlpools-core` for state snapshots and math — `fetchPositionsForOwner`, `harvestPosition`, `decreaseLiquidity`, `closePosition`. (Legacy `@orca-so/whirlpools-sdk` only if [1B.0] chose Web3.js v1.)
- Done when: 5 Whirlpool positions decode; fee vs principal separated on rebalances; NFT transfers not misclassified as income.
- Depends on: [1B.0], [1B.1], [1B.2], [0.3]

**[1B.4] Solana golden-fixture tests**
- Labels: `phase-1b-solana`, `test-fixtures`
- Hand-label ~10 gnarly txs (partial close, rebalance with collect+increase, fee+reward harvest same tx, NFT transfer).
- Done when: `tests/fixtures/solana-golden.json`; Orca handler passes all.
- Depends on: [1B.3]

### Phase 1C: Sui end-to-end (~4–6 days, riskiest)

**[1C.1] Sui spike — event-type discovery for Turbos, Navi, Suilend**
- Labels: `phase-1c-sui`, `spike`, `risk`
- Run `sui-events-indexer -p <package_id>` for each protocol. Auto-generate TypeScript event interfaces. Verify the Navi deprecation (see 02-claims-verification) doesn't block historical event decoding. **Should run before committing Phase 1C timeline.**
- Done when: `types/turbos-events.ts`, `types/navi-events.ts`, `types/suilend-events.ts` compile; all 13 Suilend events enumerated; haSUI loop events identified.
- Depends on: (can run in parallel with Phase 1A/1B)

**[1C.2] Sui ingest adapter**
- Labels: `phase-1c-sui`, `infra`
- `suix_queryTransactionBlocks({ filter: { FromAddress } })` + `sui_getTransactionBlock({ showEvents: true })`. Idempotent by tx digest.
- Done when: `src/chains/sui/ingest.ts`; rerun skips fetched; sample Turbos/Navi txs present.
- Depends on: [0.1], [1C.1]

**[1C.3] Turbos CLMM handler**
- Labels: `phase-1c-sui`, `handler`
- Match Move call targets (`position_manager::mint`, `::increase_liquidity`, `::decrease_liquidity`, `pool::collect_fee`). Amounts from events or `balanceChanges`. Position object ID → `positionId`.
- Done when: 3 Turbos lifecycle events decode; uses shared position tracker.
- Depends on: [1C.2], [1C.1], [1B.2], [0.3]

**[1C.4] Navi handler + haSUI loop detector**
- Labels: `phase-1c-sui`, `handler`, `risk`
- Depend on **`@naviprotocol/lending`** (from `naviprotocol-monorepo`, not the deprecated `navi-sdk`) for types. Decode `DepositEvent`, `WithdrawEvent`, `BorrowEvent`, `RepayEvent`, `ClaimRewardEvent`, `LiquidateEvent`, `FlashLoanEvent` (+ whatever [1C.1] discovers via indexer) via raw Move events over Sui RPC. Use `getUserClaimedRewardHistory(address, page, size)` as a cross-check for reward-claim coverage. haSUI loop detector scans for `deposit haSUI → borrow SUI → stake → re-deposit` within a single tx digest. **Tax policy decision documented: re-stake of borrowed SUI is not a disposal** (German §23 has no definitive answer — clean-room decision, revisit with Steuerberater).
- Done when: handler decodes Navi events; `getUserClaimedRewardHistory` cross-check matches decoded reward events; looping tagged `looping_pattern`; borrow classified as borrow (not income); policy decision written to `docs/tax-policy.md`.
- Depends on: [1C.2], [1C.1], [0.3]

**[1C.5] Suilend handler (all 13 events)**
- Labels: `phase-1c-sui`, `handler`
- Decode `MintEvent`, `RedeemEvent`, `DepositEvent`, `WithdrawEvent`, `BorrowEvent`, `RepayEvent`, `ForgiveEvent`, `LiquidateEvent`, `ClaimRewardEvent`, `InterestUpdateEvent`, `ReserveAssetDataEvent`, `ClaimStakingRewardsEvent`, `ObligationDataEvent`. ctoken ↔ underlying conversions.
- Done when: all 13 types handled; 3 supply+borrow scenarios decode; ctoken conversion correct.
- Depends on: [1C.2], [1C.1], [0.3]

**[1C.6] Sui golden-fixture tests**
- Labels: `phase-1c-sui`, `test-fixtures`
- Hand-label ~5 gnarly txs (haSUI looping, Navi liquidation, Turbos rebalance, Suilend supply+reward, cross-protocol atomic op).
- Done when: `tests/fixtures/sui-golden.json`; all 3 handlers pass.
- Depends on: [1C.3], [1C.4], [1C.5]

### Phase 1D: Polish (~2–3 days)

**[1D.1] CoinGecko price cache + DefiLlama fallback**
- Labels: `phase-1d-polish`, `infra`
- SQLite `prices` keyed by `(asset, date)`. Daily granularity. Rate-limit backoff (10-50 cpm). Batch dedup. Fallback to DefiLlama for tokens CoinGecko misses.
- Done when: 100-tx backfill completes without rate-limit errors in <5 min on warm cache.
- Depends on: — (parallel)

**[1D.2] Cross-chain transfer linker**
- Labels: `phase-1d-polish`, `decoder-core`
- Heuristic: within 30-min window, match out-on-A with in-on-B for same asset + same owner. Ambiguous matches flagged. `transfer_links` table.
- Done when: Bridge tx (Base→Solana) gets linked; ambiguous cases surface in TUI.
- Depends on: — (parallel)

**[1D.3] Ink/Inquirer TUI for unclassified txs**
- Labels: `phase-1d-polish`, `infra`
- Interactive classifier. Ask type/subtype/amounts. Save classification as rule (future auto-match) or manual override.
- Done when: 1 unclassified tx labeled in <30s; classification persists; re-decode respects it.
- Depends on: — (parallel)

**[1D.4] Unified golden-fixture suite + Koinly validation**
- Labels: `phase-1d-polish`, `test-fixtures`
- Merge all hand-labeled fixtures. Run full pipeline; validate CSV against Koinly import. **Default label for `lp_fee` and `lp_reward` is `reward`** (per doc 04 research — matches Koinly's custom-CSV vocabulary; Germany treats `reward` and `stake` identically as income at receipt with 1yr holding period). Empirically compare against `other income` and blank in a Koinly sandbox.
- Done when: `npm run test:fixtures` passes all ~20 txs; Koinly sandbox import confirms `reward` produces the correct German income classification; chosen labels documented in `config/koinly-labels.ts`.
- Depends on: [1A.6], [1B.4], [1C.6]

---

## Open questions to answer before creating issues

### 1. Repo location: sibling repo vs subfolder?

**Recommendation:** sibling `liquidity-tax/`. The existing `liquidity-sheets` repo is a Google Sheets automation / skills project with zero runtime overlap with a TypeScript on-chain decoder. Sibling keeps concerns clean.

### 2. Sui spike timing?

**Recommendation:** run **[1C.1]** immediately after Phase 0 bootstrap (before Phase 1A), because (a) the Navi SDK deprecation finding raises the risk profile, and (b) if event discovery fails, we can ship Base+Solana only and defer Sui to Phase 2 instead of churning mid-project.

### 3. Which wallet addresses to hardcode?

**Recommendation:** all historical wallets Felix can identify, tagged active vs archived. Config format: `config/wallets.ts` exporting `Array<{chain, address, label, status}>`. Ingest all; events naturally separate by `walletAddress`.

### 4. Test-first workflow granularity (per global CLAUDE.md)?

**Recommendation:** ingest real history in Phase 0 before handlers exist. Within each phase: (a) ingest first, (b) implement handler, (c) hand-label ≥3 real txs as fixtures, (d) tests pass = handler "done". The global "test-first" rule applies at the handler level, using real on-chain txs as failing-test inputs rather than synthetic mocks.

### 5. Koinly label mapping for `lp_fee` / `lp_reward`?

**Resolved in doc 04:** default to `reward` (matches Koinly's custom-CSV vocabulary). `other income` is semantically equivalent in Koinly's tax engine and is what staketaxcsv emits for `INCOME` rows. Germany treats `reward` and `stake` identically (income at receipt, 1yr holding). Phase 1D [1D.4] confirms via sandbox import against `reward` / `other income` / blank.

---

## What to do right now

1. Answer the 5 open questions (esp. #1 repo location) so issue creation can start.
2. Commission follow-up research on the surprising findings from `02-claims-verification-20260418.md` (Navi deprecated → successor SDK; Whirlpools `legacy-sdk/` → current SDK).
3. Sign up for Day-1 accounts (Helius, Alchemy, CoinGecko Demo, Koinly, GitHub repo).
4. Run `/plan` with all three planning docs as input.
