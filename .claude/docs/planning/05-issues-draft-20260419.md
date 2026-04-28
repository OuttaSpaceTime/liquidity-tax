# Issue Drafts — Phase 0 + Phase 1A + Future (REVISED)

**Date:** 2026-04-19
**Revision:** v2 — critic + reference-miner findings applied.
**Status:** Ready for `gh issue create`.
**Source decisions:** `03-accounts-and-initial-issues-20260418.md` + walkthrough 2026-04-19.

---

## Locked decisions

| Decision | Value |
|---|---|
| Repo location | Sibling `liquidity-tax/` (this dir) |
| Sui spike timing | Task 1 of Phase 1C |
| Wallet set | All historical, tagged active/archived |
| Test-first granularity | Per-handler, ≥3 hand-labeled real txs before code |
| Solana stack | Web3.js v2 + `@orca-so/whirlpools` v7 |
| Handler registration | Explicit in `src/decoders/index.ts` |
| Position ID format | `{chain}:{protocol}:{id}` |
| Gas fees | Separate Koinly rows, **emitted at ingest time** (not post-decode) |
| Flash loans | Out of scope → `[F.1]` |
| Secrets | `.env` + dotenv, `.env.example` checked in |
| DB/ORM | `better-sqlite3` + `drizzle-orm` + `drizzle-kit` |
| `raw_txs → events` | No `CASCADE` |
| Aerodrome scope | LP + gauge bundled in `[1A.4]` |
| Aave SDK | `@aave/client` (viem-native) |
| Koinly label for `lp_fee`/`lp_reward` | `reward` |
| **`UniV3LikeBase` extraction** | **Upfront in `[1A.3]`** — not deferred |
| **`lend_interest:accrued` synthesis** | **Skip for MVP** — Koinly derives gains from supply/withdraw deltas. Revisit if Koinly output looks wrong. |
| **Gas row style** | Separate rows (not attached to main rows via Fee column). Guard at export: a given tx's gas appears in exactly one row. |
| **Decode idempotency** | Re-running decode on same `raw_txs` produces byte-identical `events`. Decoder wipes+reinserts per-tx for its claimed logs. |

---

## Revised issue list — 13 issues

| # | Title | Phase |
|---|---|---|
| `[0.1]` | Repo scaffolding + Drizzle SQLite schema + config | 0 |
| `[0.2]` | Canonical `TaxEvent` type + (type, subtype) matrix | 0 |
| `[0.3]` | `Handler` interface + `DecoderRegistry` + 3-phase dispatch | 0 |
| `[1A.0]` | Base tx dump + fixture capture (before handlers) | 1A |
| `[1A.1]` | Base ingest adapter (viem) + gas event emission | 1A |
| `[1A.2]` | Koinly CSV exporter | 1A |
| `[1A.3]` | Uniswap V3 handler (Base) + `UniV3LikeBase` extraction | 1A |
| `[1A.4]` | Aerodrome handler (Base, LP + gauge bundled) | 1A |
| `[1A.5]` | Aave V3 handler (Base, viem-native) | 1A |
| `[1A.6]` | Base end-to-end smoke + Koinly sandbox import | 1A |
| `[1A.7]` | Self-transfer detection + `transfer_links` population | 1A |
| `[1A.8]` | CoinGecko price fetcher + `prices` table writer | 1A |
| `[F.1]` | (Future) Revisit flash loan decoding | Future |

Bridges (cross-chain linker) and multi-wallet grouping beyond self-transfers live in Phase 1D (`[1D.2]`) — separate batch after Phase 1A ships.

---

## Issue bodies

### [0.1] Repo scaffolding + Drizzle SQLite schema + config

**Labels:** `phase-0`, `infra`

**Summary.** Bootstrap TypeScript CLI skeleton, Drizzle schema for 7 tables, wallet config, secrets loader.

**Scope.**
- `package.json`: `typescript`, `tsx`, `better-sqlite3`, `drizzle-orm`, `drizzle-kit`, `dotenv`, `zod`, `vitest`, ESLint + Prettier.
- `tsconfig.json`: `strict: true`, `target: ES2022`, `module: NodeNext`.
- `db/schema.ts` — 7 tables via Drizzle `sqliteTable`:
  - `raw_txs(chain, tx_hash, block_number, block_timestamp, raw_json, fetched_at)` PK `(chain, tx_hash)`
  - `events(id, chain, tx_hash, log_index, emission_seq, timestamp, wallet, type, subtype, sent_asset, sent_amount, received_asset, received_amount, price_usd_json, position_id, flags_json, handler_id, handler_version)` — `*_amount` as `blob({mode:'bigint'})`, JSON columns via `.$type<T>()`. `emission_seq` disambiguates multiple events at the same `log_index`.
  - `positions(position_id, chain, protocol, wallet, opened_at, closed_at, state_json)`
  - `prices(asset, date, usd_price, source)` PK `(asset, date)`
  - `unclassified(chain, tx_hash, raw_json, reason, first_seen_at, resolved_at)` PK `(chain, tx_hash)`
  - `rules(id, match_json, template_json, priority, created_at, last_applied_at, applied_count)`
  - `transfer_links(id, out_event_id, in_event_id, confidence, status, heuristic)`
  - **No `ON DELETE CASCADE`** on `raw_txs → events`.
- `db/migrate.ts` — applies drizzle-kit-generated migrations from `db/migrations/` tracking state in `_migrations` table.
- `drizzle.config.ts` — `{schema: './db/schema.ts', out: './db/migrations', dialect: 'sqlite'}`.
- `config/wallets.ts` — `Array<{chain, address, label, status: 'active' | 'archived'}>` with all historical wallets.
- `src/config/env.ts` — Zod-validated env loader, clear error on missing keys.
- `.env.example` with `HELIUS_API_KEY`, `ALCHEMY_API_KEY`, `COINGECKO_API_KEY`, `SUI_RPC_URL`.
- `npm run db:generate` / `db:migrate` / `db:studio` scripts.
- `handler_version` usage documented: when a handler bumps its version, corresponding `events` rows are eligible for re-decode from `raw_txs`.

**Done when.**
- [ ] `npm run build` passes.
- [ ] `npm run db:generate` produces a clean initial migration.
- [ ] `npm run db:migrate` creates all 7 tables.
- [ ] `npm run db:studio` opens; all tables visible + empty.
- [ ] `config/wallets.ts` includes at least one real wallet entry.
- [ ] `.env.example` checked in; `.env` gitignored.

**Reference patterns.**
- Mirror: `onchain/rotki/rotkehlchen/db/schema.py` — `history_events` table with composite uniqueness + discriminator column; direct inspiration for `events`.
- Mirror: `onchain/rotki/rotkehlchen/db/upgrades/` — version-numbered migration file layout.

**Depends on.** —

---

### [0.2] Canonical `TaxEvent` type + (type, subtype) matrix

**Labels:** `phase-0`, `schema`, `decoder-core`

**Summary.** Encode the tax-event taxonomy as a TypeScript type enforcing valid `(type, subtype)` pairs at compile time.

**Scope.**
- `src/types/event.ts`:
  - `TaxEventMap` — 15-key record, values as string-union subtypes.
  - `TaxEventType = keyof TaxEventMap`; `SubtypeOf<T> = TaxEventMap[T]`.
  - `interface TaxEvent<T extends TaxEventType = TaxEventType>` with `type: T; subtype: SubtypeOf<T>`.
  - `type Flag` — non-destructive annotations: `'looping_pattern' | 'rebalance_embedded' | 'bridge_out' | 'bridge_in' | 'auto_compounded' | 'wrapped_native' | 'dust' | 'self_transfer' | 'flash_loan'`.
  - `PositionId` template literal: `` `${Chain}:${Protocol}:${string}` ``.
- **Frozen matrix:**
  - `transfer: 'send' | 'receive' | 'self_transfer' | 'wrap' | 'unwrap'`
  - `swap: 'trade'`
  - `lp_deposit: 'open_position' | 'add_liquidity'`
  - `lp_withdraw: 'remove_liquidity' | 'close_position'`
  - `lp_fee: 'collect'`
  - `lp_reward: 'gauge_claim' | 'emission_claim'`
  - `lend_supply: 'deposit' | 'withdraw'`
  - `lend_borrow: 'borrow' | 'repay'`
  - `lend_interest: 'accrued'` (reserved — not emitted in MVP; `[1A.5]` TODO)
  - `lend_reward: 'claim'`
  - `liquidation: 'collateral_seized' | 'debt_repaid'`
  - `stake: 'delegate' | 'undelegate' | 'reward'`
  - `bridge: 'out' | 'in'` (reserved — populated by `[1D.2]`)
  - `gas: 'fee'`
  - `unknown: 'needs_classification'`
- Compile-time tests: `TaxEvent<'lp_fee'>` with `subtype: 'gauge_claim'` must fail `tsc --noEmit`.
- Seed `config/koinly-labels.ts` with entries for **every** `(type, subtype)` including `liquidation:*` and `lend_interest:*`:
  - `liquidation:collateral_seized` → `''` (treat as realized; annotate via Description)
  - `liquidation:debt_repaid` → `'loan repayment'`
  - `lend_interest:accrued` → `'lending interest'` (reserved; unused in MVP)

**Done when.**
- [ ] Invalid `(type, subtype)` pairs fail `tsc --noEmit`.
- [ ] All 15 types + subtypes documented inline.
- [ ] `events.type` / `events.subtype` columns carry `.$type<...>()` narrowing.
- [ ] `config/koinly-labels.ts` has an entry for every valid pair (no gaps).

**Reference patterns.**
- Mirror: `onchain/rotki/rotkehlchen/history/events/structures/types.py` — `HistoryEventType × HistoryEventSubType` with ~150 validated pairs (AGPL — reimplement).
- Mirror: `onchain/raccoin/src/base.rs:216-268` — discriminated-union `Operation` enum.
- Reference: `onchain/bittytax/src/bittytax/bt_types.py:25-55` — `BUY_TYPES` / `SELL_TYPES` + Loan/Interest mapping.
- Reference: `onchain/staketaxcsv/src/staketaxcsv/common/ExporterTypes.py:76-106` — proven minimal tx-type taxonomy.

**Depends on.** `[0.1]`.

---

### [0.3] `Handler` interface + `DecoderRegistry` + 3-phase dispatch

**Labels:** `phase-0`, `decoder-core`, `infra`

**Summary.** Formalize the plug-in contract and dispatcher. Guarantee deterministic, idempotent decode.

**Scope.**
- `src/decoders/types.ts`:
  ```ts
  interface Handler {
    readonly id: string
    readonly version: string
    readonly chain: Chain
    matches(raw: RawTx): boolean
    decode(raw: RawTx, ctx: DecodeContext): DecodeResult
  }
  type DecodeResult =
    | { kind: 'ok'; events: TaxEvent[] }
    | { kind: 'skip' }
    | { kind: 'unclassified'; reason: string }
  ```
- `src/decoders/registry.ts`:
  - **Phase 1 — handler dispatch.** Iterate registered handlers in registration order. Each may contribute events. Each event must carry `log_index` + `emission_seq` (0-indexed within that handler's emissions for that log).
  - **Phase 2 — rules fallback.** Any raw component not claimed by a handler is matched against `rules`.
  - **Phase 3 — aggregation.** Run post-decode passes: looping-pattern detection, position lifecycle updates, duplicate guard, deterministic sort.
  - Anything unclassified after 3 phases → `unclassified` table with reason.
- **Duplicate-emission guard**: seen-set key is `(chain, tx_hash, log_index, emission_seq, type, subtype)`. Collision throws `DuplicateEmissionError` naming both emitting handlers.
- **Deterministic order**: final events sorted by `(tx_hash, log_index, emission_seq, handler_id)` — stable across runs.
- **Idempotent decode**: `registry.decodeAndPersist(tx_hash)` is a transaction that deletes existing `events` rows for that tx then inserts the new set. Re-running produces byte-identical rows.
- `src/decoders/index.ts` — explicit registration list; stubs for all future handlers with `matches() { return false }`.
- Unit tests: dispatch to registered handler; unmatched tx → `unclassified`; two handlers emitting same `(log_index, emission_seq, type, subtype)` → throw; re-running `decodeAndPersist` produces identical row bytes.

**Done when.**
- [ ] `Handler` interface + `DecoderRegistry` exported.
- [ ] All 3 phases implemented + tested.
- [ ] Duplicate-emission guard uses full key spec above.
- [ ] Re-running decode on same `raw_txs` yields byte-identical `events` (test with SHA-256 comparison).
- [ ] Final event order is deterministic (test: shuffle handler registration order; row order must be unchanged).
- [ ] Unclassified fallback writes to `unclassified` with non-empty `reason`.

**Reference patterns.**
- Mirror: `onchain/rotki/rotkehlchen/chain/evm/decoding/decoder.py` — `addresses_to_decoders()` / `decoding_rules()` / `post_decoding_rules()` three-phase pattern.
- Reference: `onchain/rotki/rotkehlchen/chain/evm/decoding/uniswap/v3/decoder.py` — worked example using all 3 phases.
- Reference: `onchain/staketaxcsv/src/staketaxcsv/sol/processor.py` — simpler program-ID → handler dispatch as fallback pattern.

**Depends on.** `[0.2]`.

---

### [1A.0] Base tx dump + fixture capture (before handlers)

**Labels:** `phase-1a-base`, `test-fixtures`

**Summary.** Dump real Base history for all configured wallets, select ~5 gnarly candidates, commit hand-labeled fixtures. This precedes handler issues per test-first rule.

**Scope.**
- `scripts/dump-base-history.ts` — reads `config/wallets.ts`, queries Alchemy for every tx involving configured contracts, writes full receipts to `tests/fixtures/base-raw/<tx_hash>.json`.
- `tests/fixtures/base-golden.json` — JSON array of `{ txHash, expectedEvents: TaxEvent[], expectedCsvRows: string[], notes: string }`.
- **5 candidate txs to hand-label** (swap in as the corpus reveals):
  1. Uni V3 full rebalance — decrease + collect + increase in one tx
  2. Aerodrome LP open + immediate gauge stake
  3. Aerodrome gauge rewards claim
  4. Aave supply + borrow in the same tx
  5. Aave liquidation (if present) OR multi-protocol atomic op
- Each fixture's `expectedEvents` written **before** the handler exists — they are initially-failing tests.

**Done when.**
- [ ] `tests/fixtures/base-raw/` contains ≥5 real tx JSONs.
- [ ] `tests/fixtures/base-golden.json` hand-labeled for all 5.
- [ ] A Vitest run (with no handlers wired) shows the 5 fixture assertions failing with the expected error shape.
- [ ] Failing test run output pasted into the PR as the test-first artifact.

**Reference patterns.**
- Mirror: `onchain/rotki/rotkehlchen/tests/unit/decoders/test_aerodrome.py`, `test_aave_v3.py` — real-tx fixture layout with hand-labeled expected events.
- Reference: `onchain/solana-tx-parser-public/tests/parseDlnSrcTransaction.test.ts` — recorded raw JSON + expected decoded output layout.

**Depends on.** `[0.2]`, `[0.3]`, `[1A.1]` (needs ingest to dump).

---

### [1A.1] Base ingest adapter (viem) + gas event emission

**Labels:** `phase-1a-base`, `infra`

**Summary.** Pull Base tx receipts via Alchemy. Idempotent. Emits `gas:fee` events during ingest (gas is a fact about the tx, owned here — not by any protocol handler).

**Scope.**
- `src/chains/base/client.ts` — viem `createPublicClient({chain: base, transport: http(ALCHEMY_URL)})`.
- `src/chains/base/ingest.ts`:
  - For each `{address, status}` in `config/wallets.ts` where chain=base:
    - Resume from `SELECT MAX(block_number) FROM raw_txs WHERE chain='base' AND wallet_from_receipt=addr`.
    - `fromBlock` defaults to the wallet's first-funding block if unknown (lookup via Alchemy asset transfers) or `0` as a safety fallback.
    - Iterate in 10k-block chunks. On `getLogs` length ≥ 10k result, halve chunk and retry (adaptive chunking).
    - For each matched tx hash, `getTransactionReceipt` + `getTransaction` (gas data).
    - Insert `raw_txs` row with `ON CONFLICT DO NOTHING`.
- **Gas event emission** (post-insert, before handlers run):
  - For each newly ingested tx, compute `gasUsed * effectiveGasPrice` in wei.
  - Emit one `TaxEvent` with `type: 'gas'`, `subtype: 'fee'`, `wallet = tx.from`, `sent_asset = 'ETH'`, `sent_amount = gas_wei`, `log_index = -1` (sentinel for gas rows), `emission_seq = 0`, `handler_id = 'base_ingest_gas'`.
  - Insert into `events` as part of the same transaction.
- Rate-limit handler: exponential backoff on 429, with a test that mocks a 429 and asserts retry.

**Done when.**
- [ ] `npm run ingest:base` fetches ≥10 real txs into `raw_txs`.
- [ ] Rerun skips already-fetched txs (logged).
- [ ] No duplicate `(chain, tx_hash)` rows (enforced by PK).
- [ ] Every `raw_txs` row has exactly one `gas:fee` event in `events` (test: count join).
- [ ] 429 mock → exponential retry + eventual success, verified by unit test.
- [ ] Adaptive chunking test: a chunk returning 10k logs triggers halving; covered by a synthetic test.

**Reference patterns.**
- Mirror: `onchain/v3-subgraph/abis/` — drop-in JSON ABIs for `parseAbi` / `getLogs` (no need to compile `v3-periphery`).
- Reference: `onchain/v3-subgraph/config/` — per-network factory + NPM address + start block for `fromBlock` defaults.
- Reference: `onchain/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol` — authoritative event signatures.

**Depends on.** `[0.1]`, `[0.2]`.

---

### [1A.2] Koinly CSV exporter

**Labels:** `phase-1a-base`, `export`

**Summary.** Emit Koinly-compatible custom CSV from `events`. No double-counting of gas. All `(type, subtype)` pairs mapped.

**Scope.**
- `config/koinly-labels.ts` — `Record<\`${TaxEventType}:${TaxEventSubtype}\`, KoinlyLabel>`:
  - `lp_fee:collect` → `'reward'`
  - `lp_reward:gauge_claim` → `'reward'`
  - `lp_reward:emission_claim` → `'reward'`
  - `lend_reward:claim` → `'reward'`
  - `swap:trade` → `'swap'`
  - `lend_borrow:borrow` → `'loan'`
  - `lend_borrow:repay` → `'loan repayment'`
  - `lp_deposit:*` → `''` (Koinly auto Liquidity In)
  - `lp_withdraw:*` → `''` (Koinly auto Liquidity Out)
  - `lend_supply:deposit` → `''` (Koinly auto; cost-basis unchanged)
  - `lend_supply:withdraw` → `''`
  - `transfer:self_transfer` → `''` (neutral; handled via `transfer_links`)
  - `transfer:send` / `transfer:receive` → `''` (determined by Koinly from row shape)
  - `transfer:wrap` / `transfer:unwrap` → `''`
  - `stake:delegate` → `'stake'`
  - `stake:undelegate` → `''`
  - `stake:reward` → `'reward'`
  - `bridge:out` → `''` (linked via `transfer_links`)
  - `bridge:in` → `''`
  - `liquidation:collateral_seized` → `''` (with Description flagging)
  - `liquidation:debt_repaid` → `'loan repayment'`
  - `lend_interest:accrued` → `'lending interest'` (reserved; not emitted in MVP)
  - `gas:fee` → `''` (emitted as own row; see gas guard below)
  - `unknown:needs_classification` → export filter excludes these (not in CSV)
- `src/export/koinly-csv.ts`:
  - 12-column schema from `staketaxcsv/common/ExporterTypes.py:386-412` (byte-identical order).
  - Each `events` row → one CSV row. `gas:fee` rows go in the `Sent Amount / Sent Currency` columns; the main event row's `Fee Amount / Fee Currency` columns stay **empty**.
  - **Gas double-count guard**: test asserts `SUM(sent when type='gas') + SUM(Fee column from non-gas rows) = SUM(sent when type='gas')`. I.e., no non-gas row has Fee populated in Phase 1A.
  - `Net Worth` columns populated iff `[1A.8]` price writer has data; otherwise left blank.
- `npm run export:koinly -- --since=2023-01-01 --out=./koinly.csv`.

**Done when.**
- [ ] Column order byte-identical to staketaxcsv reference.
- [ ] Every `(type, subtype)` in the matrix has an explicit `koinly-labels.ts` entry.
- [ ] Gas double-count guard test passes.
- [ ] Re-running export twice produces byte-identical CSV (determinism).
- [ ] Sample CSV parses in Koinly sandbox (smoke — full validation in `[1D.4]`).
- [ ] `Net Worth` left blank in Phase 1A unless `[1A.8]` landed.

**Reference patterns.**
- Mirror: `onchain/staketaxcsv/src/staketaxcsv/common/ExporterTypes.py:386-412` — 12-column Koinly schema (MIT, copy verbatim).
- Mirror: `onchain/staketaxcsv/src/staketaxcsv/common/Exporter.py:942-964` — `tx_type → Koinly label` map reference.
- Reference: `onchain/staketaxcsv/src/staketaxcsv/common/Exporter.py:178` — LP_TREATMENT pattern.

**Depends on.** `[0.2]`.

---

### [1A.3] Uniswap V3 handler (Base) + `UniV3LikeBase` extraction

**Labels:** `phase-1a-base`, `handler`

**Summary.** Decode Uni V3 LP lifecycle and fee collection on Base. Extract shared `UniV3LikeBase` class used by `[1A.4]`.

**Scope.**
- `src/decoders/base/uniswap-v3-like.ts` — abstract `UniV3LikeBase implements Handler`: shared NPM event parsing, Transfer-log pairing, position tracking, fee-vs-principal split. Subclasses supply NPM address + protocol string + (optional) gauge hooks.
- `src/decoders/base/uniswap-v3.ts` — concrete subclass: NPM address = `UNI_V3_NPM`, protocol = `'uniswap-v3'`. `matches(raw)` excludes Aerodrome addresses (explicit deny-list).
- Decodes: `IncreaseLiquidity`, `DecreaseLiquidity`, `Collect`. Pairs with ERC-20 `Transfer` logs for token identity.
- Emission rules:
  - First `IncreaseLiquidity` on new tokenId → `lp_deposit:open_position`
  - Subsequent `IncreaseLiquidity` on same tokenId → `lp_deposit:add_liquidity`
  - `DecreaseLiquidity` + `Collect` same-tx: split — principal portion (matched to DecreaseLiquidity amounts) → `lp_withdraw:remove_liquidity`; excess → `lp_fee:collect`
  - `Collect` without prior `DecreaseLiquidity` same tx → `lp_fee:collect`
  - Full close (liquidity → 0 + NFT Burn) → `lp_withdraw:close_position`
- `positionId = \`base:uniswap-v3:${tokenId}\``.
- Updates `positions` table.

**Test-first (per global CLAUDE.md).**
- `[1A.0]` fixtures include ≥3 Uni V3 txs (open, add, rebalance). They must be committed and failing **before** handler code lands.
- Acceptance: include a **rebalance test** (decrease+collect+increase in one tx) that asserts fee and principal rows are split correctly. This is the single most error-prone case.

**Done when.**
- [ ] `UniV3LikeBase` abstract class committed **in this PR** (not deferred).
- [ ] ≥3 fixtures from `[1A.0]` pass.
- [ ] Rebalance fixture's fee vs principal assertion passes.
- [ ] Failing-test run (before handler code) pasted in PR.
- [ ] Handler registered in `src/decoders/index.ts`.
- [ ] Position lifecycle reflected in `positions`.

**Reference patterns.**
- Mirror: `onchain/rotki/rotkehlchen/chain/evm/decoding/uniswap/v3/decoder.py` (~412 lines) — full worked reference incl. fee-vs-principal split (AGPL — reimplement).
- Mirror: `onchain/v3-periphery/contracts/libraries/LiquidityAmounts.sol` — `getAmountsForLiquidity` math for amount reconstruction if log amounts ambiguous.
- Reference: `onchain/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol` — `positions(tokenId)` struct for enrichment.

**Depends on.** `[1A.0]`, `[1A.1]`, `[0.3]`.

---

### [1A.4] Aerodrome handler (Base, LP + gauge bundled)

**Labels:** `phase-1a-base`, `handler`

**Summary.** Decode Aerodrome Slipstream LP events + gauge staking + AERO gauge rewards. Subclass of `UniV3LikeBase`.

**Scope.**
- `src/decoders/base/aerodrome.ts` — `class AerodromeHandler extends UniV3LikeBase`. Slipstream NPM address + Aerodrome gauge addresses.
- LP events: inherit from `UniV3LikeBase` (identical event shapes).
- Gauge events:
  - `Deposit`/`Withdraw` on gauge → emit **nothing** (LP token moves into the gauge contract; not a tax event; the LP position itself is still yours).
  - `ClaimRewards(rewardToken, amount)` → `lp_reward:gauge_claim` with `received_asset = AERO`.
- `matches(raw)` — positive match on Slipstream NPM or any registered gauge contract.

**Test-first.**
- `[1A.0]` fixtures include ≥3 Aerodrome txs (LP open, rebalance, gauge claim). Committed + failing before handler.

**Done when.**
- [ ] LP lifecycle events reuse `UniV3LikeBase` (no duplicated code).
- [ ] AERO rewards labeled `lp_reward:gauge_claim`.
- [ ] Gauge Deposit/Withdraw emits nothing (no `transfer:self_transfer` noise).
- [ ] ≥3 fixtures pass.
- [ ] Failing-test run (before handler) pasted in PR.

**Reference patterns.**
- Mirror: `onchain/rotki/rotkehlchen/chain/base/modules/aerodrome/decoder.py` — 51-line subclass of `VelodromeLikeDecoder`; canonical fork-inheritance pattern.
- Mirror: `onchain/rotki/rotkehlchen/chain/evm/decoding/velodrome/decoder.py` (~569 lines) — parent class for every Velodrome-family event.
- Reference: `onchain/rotki/rotkehlchen/chain/evm/decoding/velodrome/velodrome_cache.py` — pool/gauge discovery pattern if dynamic enumeration needed.

**Depends on.** `[1A.3]`.

---

### [1A.5] Aave V3 handler (Base, viem-native)

**Labels:** `phase-1a-base`, `handler`

**Summary.** Decode Aave V3 events on Base using `@aave/client`. No ethers. **No `lend_interest:accrued` synthesis in MVP** (locked decision).

**Scope.**
- `src/decoders/base/aave-v3.ts`:
  - `matches(raw)` — any log on Aave Pool (address from `@bgd-labs/aave-address-book`).
  - Decode: `Supply`, `Withdraw`, `Borrow`, `Repay`, `LiquidationCall`.
  - Emit:
    - `Supply` → `lend_supply:deposit`
    - `Withdraw` → `lend_supply:withdraw`
    - `Borrow` → `lend_borrow:borrow`
    - `Repay` → `lend_borrow:repay`
    - `LiquidationCall` → two events: `liquidation:collateral_seized` + `liquidation:debt_repaid`
- **Not in scope:** `lend_interest:accrued` synthesis. Koinly derives capital gain from supply/withdraw deltas directly. Revisit in a follow-up issue if Koinly output proves wrong.
- `@aave/client` for address resolution + reserve metadata.

**Test-first.**
- `[1A.0]` fixtures include ≥3 Aave Base txs (supply, borrow+repay, liquidation if available — else another multi-protocol op). Failing before handler.

**Done when.**
- [ ] No `ethers` or `aave-utilities` in `package.json`.
- [ ] ≥3 fixtures pass.
- [ ] Liquidation fixture emits both seized + repaid rows.
- [ ] `lend_interest:accrued` not emitted (explicit negative test).
- [ ] Failing-test run pasted in PR.

**Reference patterns.**
- Mirror: `onchain/aave-v3-core/contracts/interfaces/IPool.sol` — authoritative event ABIs (paste into `parseAbi`).
- Mirror: `onchain/rotki/rotkehlchen/chain/evm/decoding/aave/v3/decoder.py` — Pool event → event-type mapping; dual-row liquidation pattern (AGPL — reimplement).
- Reference: `onchain/aave-utilities/packages/math-utils/src/pool-math.ts` — RAY 1e27 math (MIT) for the future `lend_interest` work.
- Reference: `onchain/aave-v3-core/contracts/protocol/libraries/logic/SupplyLogic.sol` + `BorrowLogic.sol` — canonical index-accrual semantics for interest-synthesis follow-up.

**Depends on.** `[1A.0]`, `[1A.1]`, `[0.3]`.

---

### [1A.6] Base end-to-end smoke + Koinly sandbox import

**Labels:** `phase-1a-base`, `test-fixtures`, `export`

**Summary.** Run all Base handlers + exporter against the `[1A.0]` fixture corpus. Verify the produced CSV imports into a Koinly sandbox account.

**Scope.**
- `tests/base-handlers.test.ts` — runs full pipeline (ingest fixtures → decode → export) against `base-golden.json`; asserts exact `TaxEvent` equality + CSV byte-equality.
- Koinly sandbox smoke test — generated CSV imported into a fresh Koinly account; no parse errors; labels applied as expected.
- Record sandbox result (import errors, applied labels) in the PR.

**Done when.**
- [ ] `npm run test:fixtures:base` passes all 5 fixtures.
- [ ] Generated CSV imports into Koinly sandbox without errors.
- [ ] Re-running the entire pipeline twice produces byte-identical CSV.
- [ ] Self-transfer fixtures (post `[1A.7]`) also pass.

**Reference patterns.**
- Mirror: `onchain/rotki/rotkehlchen/tests/unit/decoders/test_*.py` — hand-labeled fixture layout, one test file per protocol.
- Reference: `onchain/solana-tx-parser-public/tests/` — recorded-JSON + expected-output test pattern.

**Depends on.** `[1A.3]`, `[1A.4]`, `[1A.5]`, `[1A.7]`, `[1A.0]`.

---

### [1A.7] Self-transfer detection + `transfer_links` population

**Labels:** `phase-1a-base`, `decoder-core`

**Summary.** When a `transfer` event lands on one of your own wallets, detect it and pair it with the other side so Koinly doesn't label own-wallet moves as deposits/withdrawals.

**Scope.**
- Post-decode phase (in `DecoderRegistry.aggregate`): for every `transfer:send` and `transfer:receive` where counterparty is in `config/wallets.ts`:
  - Retag as `transfer:self_transfer`.
  - Add `flags: ['self_transfer']`.
  - Within a 30-min window + same asset + same amount (±0.5%): create `transfer_links` row pairing them. `heuristic = 'same_asset_30min_own_wallet'`. `confidence = 1.0` if exact amount, else `0.8`.
- Same-chain only for Phase 1A (cross-chain is `[1D.2]`).
- TUI surface point: ambiguous matches (2 candidates in window) land with `status = 'ambiguous'` for later review.

**Done when.**
- [ ] A Base→Base transfer between two configured wallets produces one `transfer_links` row, both events tagged `self_transfer`.
- [ ] Koinly CSV labels for these rows are blank (neither deposit nor withdrawal).
- [ ] Transfer to an unconfigured external wallet remains `transfer:send` (unchanged).

**Reference patterns.**
- No strong reference — custom heuristic. Closest analog: rotki's post-decode rules iterate and tag.

**Depends on.** `[0.3]`, `[1A.1]`.

---

### [1A.8] CoinGecko price fetcher + `prices` table writer

**Labels:** `phase-1a-base`, `infra`

**Summary.** Populate `prices(asset, date, usd_price, source)` so the Koinly exporter can fill `Net Worth` columns. Phase 1A covers daily granularity for all assets seen in `events`.

**Scope.**
- `src/prices/coingecko.ts`:
  - On demand: `SELECT DISTINCT asset FROM events` → map each to CoinGecko ID (`config/coingecko-ids.ts` — seed for ETH, USDC, WETH, cbETH, AERO, AAVE, etc.).
  - For each `(asset, tx_date)` not in `prices`, fetch `/coins/{id}/history?date=DD-MM-YYYY`.
  - Rate-limit: 10-50 calls/min on free tier; exponential backoff on 429.
  - Insert with `source='coingecko'`.
- Fallback to DefiLlama `/prices/historical/{timestamp}/{chain}:{address}` for long-tail tokens not on CoinGecko (log and insert with `source='defillama'`).
- `npm run prices:fetch` script.

**Done when.**
- [ ] Every `(asset, date)` in `events` has a matching `prices` row after running `npm run prices:fetch`.
- [ ] Re-running is idempotent (no dupes, no unnecessary API calls).
- [ ] Rate-limit backoff tested with a 429 mock.
- [ ] DefiLlama fallback triggers only when CoinGecko returns 404 for the asset.

**Reference patterns.**
- Reference: `onchain/staketaxcsv/src/staketaxcsv/common/ibc/api_historical.py` — IBC-era daily-price fetch + cache pattern (shape-similar for our CoinGecko cache).

**Depends on.** `[0.1]`, `[1A.1]`.

---

### [F.1] (Future) Revisit flash loan decoding

**Labels:** `future`, `handler`, `risk`

**Summary.** Currently out of scope; flash-loan txs fall through to `unclassified`. Revisit once Phase 1 is landed.

**Scope (when taken up).**
- Aave V3 `FlashLoan(target, initiator, asset, amount, premium, referralCode)` event detection.
- Navi flash loan events (TBD from `[1C.1]` spike).
- Classify as neutral (borrow+repay in one tx, no tax) OR decode inner operations if the strategy carries tax consequences.
- Tag events with `flags: ['flash_loan']`.

**Reference patterns.**
- Reference: `onchain/aave-v3-core/contracts/interfaces/IPool.sol` — FlashLoan event signature.
- Reference: `onchain/rotki/rotkehlchen/chain/evm/decoding/aave/v3/decoder.py` — rotki's flash-loan-internal transfer skip pattern.
- Reference: `onchain/perfi/perfi/models.py:45-49` — `TX_LOGICAL_FLAG` non-destructive annotation inspiration.

**Depends on.** `[1A.5]`, `[1C.4]`, observed flash loan in corpus.

---

## Remaining open question (intentional)

Only one TODO left that's genuinely non-blocking and cosmetic:
- `[1A.4]` edge case: if a wallet ever receives AERO *outside* a gauge claim (e.g., via airdrop or OTC swap), how does the handler distinguish? Default: non-gauge AERO receipts are `transfer:receive` unless another handler claims them. Revisit if a fixture shows the wrong output.

All previously blocking TODOs are now locked in the issue bodies above.
