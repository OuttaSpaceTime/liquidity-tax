# Synthesis: Patterns, Parallels, and Divergences

## The consensus architecture

Across all 24 repos, the mature crypto tax tools converge on the same fundamental pipeline:

**Stage 1: Ingest** -- Fetch raw on-chain data per wallet. Every tool does this differently by chain (RPC calls, indexer APIs, CSV imports), but the output is always the same: a normalized representation of "what happened on-chain," cached locally for replay. Perfi calls this `tx_chain`; rotki stores raw receipt data in SQLite; staketaxcsv fetches via RPC and holds in memory. The key insight: raw data is fetched once and stored, so decoder logic can be iterated without re-fetching.

**Stage 2: Decode** -- Transform raw data into classified events. This is where per-protocol handlers live. Rotki's three-phase dispatch is the most refined implementation: (a) address-specific decoders fire first (O(1) lookup by contract address), (b) generic rules iterate remaining logs (e.g., ERC-20 transfer detection), (c) post-decode rules aggregate multi-event groups (e.g., collapsing multi-hop router swaps into one trade). The output is a canonical event with type, amounts, assets, protocol identifier, and transaction reference.

**Stage 3: Export/Compute** -- Map canonical events to output format. For staketaxcsv this is direct CSV generation. For rp2, events feed into a cost-basis engine. For our project: map events to Koinly CSV rows, with a Phase 3 option to add FIFO + Haltefrist tax computation.

The universal property: **each stage is independently testable and independently rerunnable.** You can improve decoder logic in Stage 2 without refetching chain data from Stage 1. You can change export format in Stage 3 without re-decoding. SQLite as the persistence layer between stages (perfi, rotki, our design) is the consensus choice for CLI tools.

---

## The 5 things every good crypto tax tool gets right

### 1. Per-protocol handler dispatch (not one-size-fits-all heuristics)

staketaxcsv, rotki, and BittyTax all have explicit, per-protocol decoder modules. None attempt to infer transaction semantics from generic token transfers alone. The reason is practical: a `Transfer` event from an aToken during an Aave withdrawal looks identical to a regular ERC-20 transfer without protocol context. Every mature tool routes by contract address or program ID first, then applies protocol-specific logic.

### 2. Dual-amount event model (sent + received)

staketaxcsv's `Row(sent_amount, sent_currency, received_amount, received_currency)`, BittyTax's `TransactionRecord(buy, sell)`, and Koinly's CSV format all use the same structure: every event has an optional sent side and an optional received side. A trade fills both. A deposit fills only sent. Income fills only received. This model maps directly to tax semantics (disposal = sent, acquisition = received) and to every major export format.

### 3. Transaction grouping for multi-event operations

rotki's `group_identifier + sequence_index`, perfi's `TxLogical` grouping by tx_hash, and staketaxcsv's per-tx handler calls all solve the same problem: a single on-chain transaction often produces 3-5 tax-relevant events (e.g., LP add = approve + transfer tokenA + transfer tokenB + mint LP token + fee). Without grouping, each becomes an independent line item, confusing both the user and the export format. The consensus: group by `(chain_id, tx_hash)`, order by sequence within the group.

### 4. Explicit handling of unknown/unclassified transactions

rotki falls through to generic ERC-20 transfer decoding and logs unrecognized logs without erroring. perfi's flag system marks transactions as `unknown_send` for manual review. staketaxcsv has `_` prefixed non-exportable types for internal tracking. The common principle: **never silently drop data.** Every transaction must appear somewhere -- either classified by a handler or flagged for manual review. Our `unclassified` table + TUI fallback is exactly this pattern.

### 5. Deterministic, idempotent processing

Every good tool can be rerun against the same input and produce the same output. staketaxcsv processes each tx independently (no mutable state between txs). rotki stores events with `UNIQUE(group_identifier, sequence_index)` so re-decoding replaces rather than duplicates. rp2 takes immutable input files and produces deterministic output. Our SQLite design with `(tx_hash, log_index)` primary keys inherits this property.

---

## The 5 things that separate great from good

### 1. Post-decode aggregation for composed operations

rotki's `post_decoding_rules()` phase collapses multi-hop router swaps into single spend/receive pairs, detects WETH unwrap refunds, and handles router-mediated LP operations. staketaxcsv handles this inside each handler but inconsistently. Without post-decode aggregation, a Jupiter swap through 3 pools appears as 3 separate trades instead of 1.

### 2. Protocol fork inheritance

rotki's Aerodrome decoder is 51 lines inheriting from VelodromeLikeDecoder (569 lines). This DRY pattern means adding a Velodrome fork (Aerodrome, Thena, Ramses) costs ~50 lines instead of ~600. No other repo in the set does this as cleanly. For our project, Aerodrome should inherit from a UniswapV3Like base class.

### 3. Test fixtures from real chain data (not synthetic mocks)

rotki's `tests/unit/decoders/` directory contains recorded real-world transactions covering edge cases: multi-hop swaps, partial fills, native wrapping, failed transactions. solana-tx-parser's test suite includes actual CPI-heavy transactions. The mediocre tools either have no tests or test with synthetic data that misses the real-world weirdness.

### 4. Non-destructive annotation (flags, not edits)

perfi's flag system (`unknown_send`, `zero_price`, `ignored_from_costbasis`) annotates events without modifying them. dali-rp2's transaction hints add metadata via config without touching the decoded data. This creates an audit trail: the original decoded event is preserved, and human overrides are layered on top. CoinTaxman and BittyTax lack this; edits are destructive.

### 5. Parameterized jurisdiction rules (not hardcoded tax math)

rotki's `taxfree_after_period` is a configurable integer in seconds. rp2's accounting method is a plugin selected per tax year. CoinTaxman hardcodes `relativedelta(years=1)`. The great tools treat jurisdiction-specific rules as configuration; the good tools bake them in. For our project, even though we only target Germany now, parameterizing the Haltefrist period costs nothing and enables future flexibility.

---

## Recommended canonical Event type

Based on comparing `HistoryBaseEntry` (rotki), `Row` (staketaxcsv), `InTransaction/OutTransaction` (rp2), `Operation` (raccoin), `TransactionRecord` (BittyTax), and the draft `Event` type from the exploration doc:

```typescript
/**
 * EventType x EventSubType matrix.
 * Inspired by rotki's proven taxonomy; adapted for CLMM + lending.
 * Only validated pairs are allowed (enforced at creation time).
 */
type EventType =
  | 'trade'           // Swap, buy, sell
  | 'deposit'         // Into protocol (LP, lending, staking)
  | 'withdrawal'      // From protocol
  | 'transfer'        // Between wallets (same owner)
  | 'spend'           // Gas, fees
  | 'receive'         // Income, rewards, airdrops
  | 'approval';       // Token approval (informational only -- no tax event maps to this)

type EventSubType =
  | 'none'            // Default for simple events
  | 'spend_asset'     // Outgoing leg of a trade or LP deposit
  | 'receive_asset'   // Incoming leg of a trade or LP withdrawal
  | 'fee'             // Transaction fee, protocol fee
  | 'reward'          // Staking reward, LP reward, incentive
  | 'interest'        // Lending interest (Aave, Navi, Suilend)
  | 'deposit_asset'   // Asset going into a pool/vault/lending reserve
  | 'withdraw_asset'  // Asset coming out
  | 'borrow'          // Taking a loan (Aave, Navi, Suilend)
  | 'repay'           // Repaying a loan
  | 'liquidation'     // Being liquidated
  | 'lp_add'          // Adding liquidity (CLMM or AMM)
  | 'lp_remove'       // Removing liquidity
  | 'lp_fee'          // Harvested LP trading fees
  | 'lp_reward'       // Harvested LP incentive rewards (e.g., AERO gauge)
  | 'airdrop'         // Airdrop receipt
  | 'bridge_in'       // Cross-chain bridge incoming
  | 'bridge_out';     // Cross-chain bridge outgoing

/**
 * The canonical event stored in SQLite `events` table.
 */
interface TaxEvent {
  // Identity
  id: string;                    // UUID, DB primary key
  groupId: string;               // tx_hash + chain for grouping (rotki: group_identifier)
  sequenceIndex: number;         // Ordering within group (rotki: sequence_index)

  // Classification
  type: EventType;               // Primary classification
  subtype: EventSubType;         // Secondary classification
  counterparty: string | null;   // Protocol ID: 'uniswap-v3', 'orca-whirlpools', 'aave-v3', etc.

  // Temporal
  timestamp: number;             // Unix ms (rotki, staketaxcsv all use ms or s)
  chain: 'base' | 'solana' | 'sui';

  // Amounts (dual-amount model matching Koinly CSV)
  sentAmount: string | null;     // Decimal string (rp2: RP2Decimal; raccoin: Decimal)
  sentAsset: string | null;      // Canonical asset ID
  receivedAmount: string | null;
  receivedAsset: string | null;
  feeAmount: string | null;      // Fee in native currency
  feeAsset: string | null;

  // Valuation
  sentValueUsd: number | null;   // USD value at timestamp
  receivedValueUsd: number | null;
  feeValueUsd: number | null;

  // Position tracking (our novel contribution -- no prior art)
  positionId: string | null;     // Whirlpool NFT mint, Uni V3 tokenId, Navi obligation ID, etc.

  // Provenance
  txHash: string;                // On-chain transaction hash/signature
  logIndex: number | null;       // Event index within tx (for EVM logs)
  address: string | null;        // Contract/program address that emitted the event
  walletAddress: string;         // User's wallet address

  // Metadata
  notes: string | null;          // Human-readable description
  extraData: Record<string, unknown> | null;  // Protocol-specific metadata (rotki: extra_data)
  flags: string[];               // ['auto_reconciled', 'manual_override', 'zero_price'] (perfi pattern)
}
```

**Field-by-field justification:**

| Field | Justified by |
|---|---|
| `groupId + sequenceIndex` | rotki: proven necessary for multi-event txs (LP add = 3 events). SQLite UNIQUE constraint. |
| `type + subtype` | rotki: 20x40 matrix handles edge cases flat enums cannot (e.g., deposit+fee vs withdrawal+fee). |
| `counterparty` | rotki: string (not enum) for extensibility. We use a TS string union for compile-time safety. |
| `sentAmount/receivedAmount` dual | staketaxcsv + Koinly CSV: directly maps to export format. BittyTax: buy/sell sides. |
| `string` amounts | rp2: `RP2Decimal` prevents float errors. We use decimal strings parsed to BigNumber on compute. |
| `sentValueUsd/receivedValueUsd` | rp2: explicit spot_price per side. CoinTaxman: EUR per operation. Per-side valuation is necessary for partial fills. |
| `positionId` | No prior art. CLMM positions require tracking across open/add/remove/harvest/close lifecycle. Whirlpool NFT mint address, Uni V3 tokenId, Navi obligation object ID. |
| `chain` | perfi: `Chain` enum. raccoin: `blockchain` string. Multi-chain is core to our project. |
| `flags[]` | perfi: non-destructive annotation. dali-rp2: transaction hints. Enables manual overrides without data loss. |
| `extraData` | rotki: `extra_data dict`. Protocol-specific metadata (Maker vault ID, tick range, etc.) without polluting the base schema. |
| `walletAddress` | Implicit in most repos (single-wallet). We support multiple wallets per chain. |

**Note on type x subtype valid pairs:** The `EventType` includes `deposit`/`withdrawal` and the `EventSubType` includes `deposit_asset`/`withdraw_asset`, which creates potential ambiguity (e.g., is an Aave supply `(deposit, deposit_asset)` or `(deposit, none)`?). The valid-pairs matrix -- enumerating exactly which (type, subtype) combinations are legal -- is a `/plan` deliverable, not defined here. rotki validates ~150 pairs out of ~800 theoretical combinations; we should do the same.

---

## Recommended pipeline stages

### Stage 1: Fetch & Cache (`ingest`)
- **Input:** Wallet addresses + chain configs
- **Output:** `raw_txs` table in SQLite (one row per on-chain tx, full JSON blob)
- **Behavior:** Idempotent. Re-running skips already-fetched txs (keyed by `(chain, tx_hash)`). Caches raw RPC responses verbatim.
- **Per-chain adapters:**
  - Base: `viem.getLogs()` filtered by topic + `getTransactionReceipt()`
  - Solana: `getSignaturesForAddress()` + `getTransaction()` via Helius or public RPC
  - Sui: `suix_queryTransactionBlocks({ filter: { FromAddress } })` + `sui_getTransactionBlock()` with `showEvents: true`

### Stage 2: Decode (`decode`)
- **Input:** `raw_txs` rows
- **Output:** `events` table (canonical `TaxEvent` rows)
- **Internal structure (rotki's three-phase pattern):**
  1. **Address dispatch:** Map contract/program address to registered handler. O(1) lookup. Handles Uniswap V3 NPM, Aave Pool, Whirlpool program, Turbos package, etc.
  2. **Generic rules:** For events not caught by address dispatch. ERC-20 transfers, SPL token transfers, Sui coin movements.
  3. **Post-decode aggregation:** Collapse multi-hop swaps, link compound operations (collectFees + increaseLiquidity), detect haSUI looping patterns.
- **Unclassified fallback:** Any tx not matched by a handler goes to `unclassified` table with the raw transfer data, awaiting TUI labeling.
- **Idempotent:** Re-decoding replaces events for a given `(groupId, sequenceIndex)`.

### Stage 3: Export (`export`)
- **Input:** `events` table
- **Output:** Koinly-compatible CSV (12 columns from staketaxcsv `ExporterTypes.py:386-412`)
- **Mapping:** `(type, subtype)` -> Koinly label (from staketaxcsv `Exporter.py:942-964`), LP treatment mode config.
- **Position-aware:** Groups events by `positionId` for summary reporting alongside the raw CSV.

### Stage 3b (Phase 3): Tax Compute (`tax`)
- **Input:** `events` table
- **Output:** `tax_lots` + `disposals` tables, gain/loss report
- **Engine:** FIFO lot matching (ported from rp2 `abstract_accounting_method.py`), German section 23 Haltefrist check (ported from CoinTaxman/rotki pattern), cross-chain transfer linking.

---

## What we must build from scratch (no prior art)

### 0. Koinly label mapping for CLMM-specific event subtypes
**Complexity: Small (but high-stakes for correctness)**

No repo documents how to map CLMM-specific event subtypes to Koinly labels. staketaxcsv maps `LP_DEPOSIT` -> "Liquidity In" and `LP_WITHDRAW` -> "Liquidity Out", but harvested LP trading fees (`lp_fee` in our taxonomy) have no documented Koinly label in any analyzed repo. Likely candidates: "other income" (treats fees as income, taxable immediately) or empty label (treats as a trade, which is wrong). LP rewards (`lp_reward`, e.g., AERO gauge emissions) similarly lack a clear mapping -- "staking" or "other income" are the candidates. This mapping decision directly affects tax treatment and must be resolved by testing Koinly's import behavior with each label option. This is the single most important Koinly-format question for the project.

### 1. CLMM position lifecycle tracker
**Complexity: Medium-Large**

No repo tracks concentrated-liquidity positions as first-class entities with open/add/remove/harvest/compound/close lifecycle. Every existing tool either ignores CLMM or treats each event independently.

**Approach:** Position state machine in the decoder. On `openPosition`, create a position record. On `increaseLiquidity`/`decreaseLiquidity`, update amounts. On `collectFees`/`collectRewards`, record harvest. On `closePosition`, finalize. The `positionId` field in TaxEvent links all events. SQLite `positions` table tracks lifecycle state.

### 2. Sui protocol event handlers (Turbos, Navi, Suilend)
**Complexity: Large (3+ days combined)**

Zero prior art for tax-grade decoding of any Sui DeFi protocol. The work splits into:
- **Type discovery:** Run `sui-events-indexer` against each package ID to auto-generate TypeScript event interfaces. Saves ~0.5 day.
- **Turbos handler:** Match Move call targets (`position_manager::mint`, `::increase_liquidity`, etc.) from turbos-clmm-sdk `pool.ts`. Extract amounts from `balanceChanges` in tx effects. ~1 day.
- **Navi handler:** Discover event types via bytecode disassembly (Move source NOT in repos). Build deposit/borrow/repay/claim_reward classification. haSUI loop detection (see below). ~1-1.5 days.
- **Suilend handler:** Event structs known from Move source (9 types). Build client, cursor walking, classification, ctoken conversion. ~0.5-1 day.

### 3. haSUI looping pattern detection
**Complexity: Medium**

The pattern: deposit haSUI -> borrow SUI -> stake SUI to haSUI -> deposit haSUI again, all within one ProgrammableTransaction block. No SDK models this. Must detect by analyzing sequential events within a single tx digest, identifying interleaved DepositEvent + BorrowEvent + Haedal staking calls. Tax policy decision required: is the re-stake a disposal? Encode as a configurable rule.

### 4. Orca Whirlpool CLMM instruction classifier
**Complexity: Medium**

Pairing each decoded Whirlpool instruction (via solana-tx-parser + IDL) with its sibling SPL token transfers to extract actual amounts moved. Distinguishing `collectFees` token transfers (fees) from `decreaseLiquidity` transfers (principal withdrawal). Handling compound operations (collectFees then increaseLiquidity in same tx). staketaxcsv's `handle_orca.py` covers classic swaps only, not CLMM.

**Approach:** After `flattenTransactionResponse`, iterate the flat instruction list. For each Whirlpool instruction, scan forward for adjacent SPL `transferChecked` instructions at depth+1 (CPI children). The IDL instruction name determines the tax event type; the transfer amounts are the values.

### 5. Cross-chain transfer linking
**Complexity: Small-Medium**

When Felix bridges tokens between chains, the outgoing transfer on one chain must link to the incoming transfer on another to avoid treating it as a taxable disposal+acquisition. No repo handles this for our specific chain set (Base/Solana/Sui).

**Approach:** Heuristic matching: within a time window (~30 min), match outgoing transfers on chain A with incoming transfers of the same asset on chain B for the same user. Store links in a `transfer_links` table. Flag for manual review if ambiguous.

### 6. USD price cache with historical backfill
**Complexity: Small-Medium**

CoinGecko API for historical daily prices, with aggressive SQLite caching. Rate limit handling (10-50 calls/min on free tier). Deduplicate by requesting daily granularity (not per-block). Fallback to DefiLlama for tokens CoinGecko doesn't cover.

**Approach:** `prices` table keyed by `(asset, date)`. Batch price requests using dali-rp2's TransactionManifest pattern: collect all unique (asset, date) pairs across all events, then fetch in bulk.

---

## Risk reassessment

After reading all 24 repos, here is the updated risk assessment against the original exploration doc (section 8):

### Risk 1: Sui decoder complexity -- **LOWER** (was: unknown, now: tractable)

`sui-events-indexer` provides a concrete bootstrapping path: package ID -> bytecode disassembly -> event type extraction -> TypeScript interfaces. Suilend's Move source gives clean event struct definitions for all 9 event types. Turbos SDK gives exact Move call target strings. The work is still substantial (~3 days) but no longer "unknown" -- it's well-scoped. The haSUI looping pattern remains the hardest sub-problem, but it's a single pattern to detect, not an open-ended discovery.

### Risk 2: Orca Whirlpool fee vs principal disambiguation -- **LOWER** (was: uncertain, now: solved)

The Solana agent confirmed: for historical decoding, actual fee amounts are the SPL token-transfer `amount` fields in CPI inner instructions accompanying `collectFees`/`collectFeesV2`. The `update_fees_and_rewards` gotcha only matters for "quote NOW without signing a tx" flows, not for parsing past transactions. `flattenTransactionResponse` from solana-tx-parser-public gives us the ordered instruction list needed to pair Whirlpool instructions with their transfer children.

### Risk 3: CoinGecko rate limits -- **UNCHANGED** (Medium)

Still a real concern for initial backfill of years of history. Mitigation confirmed across repos: daily-granularity requests, SQLite cache, batch deduplication. No repo found a magic bullet here.

### Risk 4: Scope creep -- **UNCHANGED** (Medium)

Still the most common failure mode for solo projects. The analysis revealed how much prior art exists, which could tempt adding a full tax engine in Phase 1. Maintain discipline: CSV export is the finish line.

### Risk 5: Test data realism -- **LOWER** (was: uncertain, now: clear strategy)

Consensus across rotki and solana-tx-parser: use real on-chain transaction data as fixtures. The approach is proven: dump historical txs to JSON on day one, hand-label ~20 gnarly ones. Not novel, just requires discipline.

### Risk 6: Looping tax policy -- **UNCHANGED** (High for correctness, Low for blocking)

No repo provides a definitive answer for German section 23 treatment of liquid-staking loops. CoinTaxman doesn't handle DeFi. Rotki's section 23 implementation doesn't cover Sui. Make the call explicit, encode as a rule, document.

### Risk 7: Protocol upgrades -- **UNCHANGED** (Low probability, Medium blast)

The whitelist approach (fail loud on unknown event shapes) is confirmed across repos. Rotki routes unknown addresses to generic decoding; our `unclassified` table serves the same purpose.

### NEW Risk 8: ethers v5 + viem dual-provider -- **NEW** (Low-Medium)

aave-utilities requires ethers v5, which is explicitly incompatible with v6 and conceptually different from viem. Running both in the same project creates dependency bloat and potential provider confusion. **Mitigation:** Isolate the ethers v5 usage in a single `aave/positions.ts` module. The rest of the codebase stays viem-only. If aave-sdk v4 drops ethers v5 support, migrate when available.

### NEW Risk 9: Anchor version mismatch between solana-tx-parser and Whirlpool IDL -- **NEW** (Low)

solana-tx-parser depends on `@coral-xyz/anchor ^0.31.1`; Whirlpool is built with Anchor 0.32. Minor-version IDL parsing usually works but could break on edge cases. **Mitigation:** Smoke test with a real Whirlpool tx early in development. The parser includes `legacy.idl.converter.ts` as a fallback.

---

## Recommended build order

### Phase 0: Bootstrap (1 day)
1. Repo scaffolding: TypeScript project, SQLite schema (raw_txs, events, prices, unclassified, rules), config with wallet addresses.
2. Copy Koinly CSV column layout from staketaxcsv `ExporterTypes.py:386-412`.
3. Define the canonical `TaxEvent` TypeScript type (from the Recommended type above).
4. Stub the decoder registry (three-phase dispatch pattern from rotki).

### Phase 1A: Base chain end-to-end (3-4 days)
5. Base ingest adapter (viem `getLogs` per protocol contract).
6. Uniswap V3 handler: drop in ABIs from v3-subgraph, decode IncreaseLiquidity/DecreaseLiquidity/Collect. Reference rotki's V3 decoder for edge cases.
7. Aerodrome handler: extend V3 handler, add gauge reward events. Reference rotki's Aerodrome/Velodrome decoder.
8. Aave V3 handler: Pool event decoding (Supply/Withdraw/Borrow/Repay). Integrate aave-utilities for position snapshots (ethers v5 isolated module).
9. Base Koinly CSV export -- prove the pipeline works end-to-end for one chain.

### Phase 1B: Solana chain (3-4 days)
10. Solana ingest adapter (getSignaturesForAddress + getTransaction).
11. Initialize SolanaParser with Whirlpool IDL from `@orca-so/whirlpools-sdk`.
12. Orca Whirlpool handler: classify openPosition/increaseLiquidity/decreaseLiquidity/collectFees/collectRewards/closePosition. Pair with SPL transfers.
13. Position lifecycle tracking (shared infra for all CLMM protocols).
14. Dump Felix's Solana history and hand-label ~10 gnarly txs as test fixtures.

### Phase 1C: Sui chain (3-5 days)
15. Run `sui-events-indexer` against Turbos, Navi, Suilend package IDs -- harvest TypeScript event types.
16. Sui ingest adapter (queryTransactionBlocks + getTransactionBlock).
17. Turbos handler: Move-call classifier + event amount extraction.
18. Navi handler: event type discovery, deposit/borrow/repay classification, haSUI loop detection.
19. Suilend handler: event parsing using Move-source-derived struct definitions.

### Phase 1D: Polish (2-3 days)
20. USD price cache (CoinGecko daily, SQLite-backed, batch requests).
21. TUI fallback for unclassified transactions (Ink or Inquirer).
22. Golden-fixture test suite: ~20 hand-labeled txs across all chains.
23. Cross-chain transfer heuristic linking.

### Phase 2 (deferred): UI
24. Optional React/Tauri dashboard reading from the same SQLite.

### Phase 3 (deferred): Tax engine
25. Port rp2's FIFO lot-matching to TypeScript (Apache 2.0).
26. Implement German section 23 Haltefrist (reference CoinTaxman + rotki, clean-room).
27. Cross-chain transfer linking for cost-basis continuity.

**Total estimated Phase 1 (MVP): 12-17 days.**

The critical-path dependency is: canonical event type -> first handler (Uniswap V3, the simplest) -> Koinly CSV export. Once this pipeline works for one protocol, adding protocols is parallelizable. Sui is last because it has the most unknowns and should land on a tested foundation.
