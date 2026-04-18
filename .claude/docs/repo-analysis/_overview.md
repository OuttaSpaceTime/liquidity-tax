# Repository Analysis Overview

## Rating Summary

| Repo | Language | Overall | Reuse | Architecture | Domain Fit | Maintenance | One-line verdict |
|---|---|---|---|---|---|---|---|
| whirlpools | TS/Rust | 5/5 | 5/5 | 4/5 | 5/5 | 5/5 | Non-negotiable dep; IDL + SDK replaces Helius for Whirlpool decoding |
| solana-tx-parser-public | TS | 5/5 | 5/5 | 4/5 | 5/5 | 4/5 | Drop-in npm; CPI flattening + IDL-based decode replaces Helius Enhanced Txs |
| v3-subgraph | AssemblyScript | 4/5 | 5/5 | 4/5 | 5/5 | 5/5 | Ships NPM + Pool ABIs directly usable with viem; subgraph itself has limits |
| v3-periphery | Solidity | 4/5 | 4/5 | 4/5 | 5/5 | 3/5 | Canonical event signatures + LiquidityAmounts math for all V3 forks |
| staketaxcsv | Python | 4/5 | 4/5 | 4/5 | 3/5 | 4/5 | Primary Koinly CSV format reference; handler dispatch pattern to adopt |
| aave-utilities | TS | 4/5 | 5/5 | 5/5 | 5/5 | 2/5 | Huge shortcut for Aave position state; accept ethers v5 cost |
| CoinTaxman | Python | 4/5 | 3/5 | 4/5 | 5/5 | 4/5 | Only German section 23 FIFO reference; AGPL blocks direct copy |
| rp2 | Python | 4/5 | 3/5 | 5/5 | 2/5 | 3/5 | Gold-standard FIFO lot-matching algorithm for Phase 3 tax engine |
| turbos-clmm-sdk | TS | 4/5 | 4/5 | 3/5 | 4/5 | 5/5 | npm dep for state snapshots + fee math; zero historical event decoding |
| sui-events-indexer | TS | 4/5 | 3/5 | 5/5 | 4/5 | 2/5 | Run once per protocol to auto-generate TS event types from bytecode |
| rotki | Python | 3.5/5 | 2/5 | 5/5 | 3/5 | 4/5 | Best-in-class EVM decoder architecture; AGPL, no Sui, limited Solana |
| aave-v3-core | Solidity | 4/5 | 3/5 | 5/5 | 5/5 | 3/5 | Source of truth for Pool event ABIs and scaled-balance semantics |
| suilend | Move | 3/5 | 1/5 | 4/5 | 5/5 | 1/5 | Essential event struct definitions; zero reusable client code |
| BittyTax | Python | 3/5 | 3/5 | 4/5 | 2/5 | 5/5 | Best loan/borrow/repay tax modeling; AGPL, UK rules |
| raccoin | Rust | 3/5 | 2/5 | 4/5 | 2/5 | 3/5 | Best discriminated-union Operation type design; EUR-first |
| aave-v3-periphery | Solidity | 3/5 | 3/5 | 3/5 | 5/5 | 2/5 | UiPoolDataProvider + RewardsController ABIs; consumed via aave-utilities |
| perfi | Python | 2/5 | 2/5 | 4/5 | 2/5 | 1/5 | Best 3-stage pipeline (chain->ledger->logical); Eth-only, AGPL |
| dali-rp2 | Python | 2/5 | 2/5 | 4/5 | 1/5 | 2/5 | Plugin architecture + transaction hints pattern; no DeFi support |
| uni-v3-position-tracker | TS | 2/5 | 2/5 | 3/5 | 2/5 | 1/5 | GraphQL query shape + fee formula reference; buggy branches, dormant |
| ethereum-etl | Python | 2/5 | 2/5 | 3/5 | 2/5 | 4/5 | Block-level ETL; wrong granularity for wallet-scoped tax use |
| solana-etl | Rust | 2/5 | 1/5 | 2/5 | 1/5 | 3/5 | Block-level ETL for Solana; ignore entirely |
| navi-sdk | TS | 2/5 | 2/5 | 2/5 | 3/5 | 4/5 | Address constants + pool configs only; zero event decoding |
| weaverfi | TS | 1/5 | 1/5 | 2/5 | 1/5 | 1/5 | Dead EVM-only portfolio tracker; skip |
| sui-tx-explainer | TS | 1/5 | 1/5 | 2/5 | 2/5 | 1/5 | Shallow generic explainer; Sui SDK docs are more useful |

**Rating disagreement note:** The individual agent rated v3-subgraph 5/5 overall, calling it "the biggest single source of free indexed data." I downgrade to 4/5. The subgraph lacks a `Position` entity (that's a separate subgraph), has GRT costs for decentralized queries, and rate limits on the hosted version. The shipped ABIs are genuinely 5/5 useful, but the subgraph as an indexed data source is supplementary, not primary, for a wallet-scoped tax CLI. What we mostly take from this repo are the JSON ABI files and the per-network config, not ongoing subgraph queries.

---

## What to steal -- concrete shopping list

### CSV exporter

#### From staketaxcsv -- Koinly CSV column layout
- **File:** `src/staketaxcsv/common/ExporterTypes.py` lines 386-412
- **What:** The exact 12-column Koinly CSV schema: Date, Sent Amount, Sent Currency, Received Amount, Received Currency, Fee Amount, Fee Currency, Net Worth Amount, Net Worth Currency, Label, Description, TxHash
- **How:** Copy verbatim. MIT license. This is the canonical format that Koinly accepts.
- **Priority:** must-have

#### From staketaxcsv -- Koinly label mapping
- **File:** `src/staketaxcsv/common/Exporter.py` lines 942-964
- **What:** The tx_type-to-Koinly-label mapping (TRADE->"", STAKING->"staking", LP_DEPOSIT->"Liquidity In", LP_WITHDRAW->"Liquidity Out", etc.)
- **How:** Port to TS. MIT license.
- **Priority:** must-have

#### From staketaxcsv -- LP treatment modes
- **File:** `src/staketaxcsv/common/Exporter.py` line 178
- **What:** Three-way LP_TREATMENT config (transfers/omit/trades) for export formats that handle LP events differently
- **How:** Reference for design; port the concept
- **Priority:** nice-to-have

### Canonical event type

#### From rotki -- HistoryEventType x HistoryEventSubType taxonomy
- **File:** `rotkehlchen/history/events/structures/types.py`
- **What:** 20 event types x 40+ subtypes covering every DeFi primitive. The validated-pairs matrix ensures only legal combinations exist.
- **How:** Reference only (AGPL). Reimplement the categorization logic as a TypeScript type x subtype matrix.
- **Priority:** must-have

#### From rotki -- group_identifier + sequence_index grouping
- **File:** `rotkehlchen/db/schema.py` (history_events table)
- **What:** `UNIQUE(group_identifier, sequence_index)` pattern for multi-event transaction grouping (e.g., LP add = spend tokenA + spend tokenB + receive LP token)
- **How:** Reference only (AGPL). Adopt the schema pattern in our SQLite.
- **Priority:** must-have

#### From raccoin -- Discriminated union Operation type
- **File:** `src/base.rs` lines 216-268
- **What:** Tagged enum with Amount payload per variant. Trade and Swap carry both incoming and outgoing. `incoming_outgoing()` returns `(Option<&Amount>, Option<&Amount>)`.
- **How:** Port pattern to TypeScript discriminated union. GPL -- reference only.
- **Priority:** must-have

#### From BittyTax -- Loan/borrow type classification
- **File:** `src/bittytax/bt_types.py` lines 25-55
- **What:** LOAN = acquisition (Buy), LOAN_REPAYMENT = disposal (Sell), LOAN_INTEREST = disposal (Sell). BUY_TYPES/SELL_TYPES classification tuples.
- **How:** Reference only (AGPL). Port the buy/sell classification for borrow/repay/interest.
- **Priority:** must-have (for Aave, Navi, Suilend handlers)

### Handler dispatch

#### From rotki -- Three-phase decoder registry
- **File:** `rotkehlchen/chain/evm/decoding/decoder.py`
- **What:** `addresses_to_decoders()` (address-specific rules, O(1) lookup), `decoding_rules()` (generic rules on every log), `post_decoding_rules()` (aggregation like multi-hop swap collapsing)
- **How:** Reference only (AGPL). Reimplement as a TypeScript DecoderRegistry with the same three phases.
- **Priority:** must-have

#### From rotki -- Protocol fork inheritance
- **File:** `rotkehlchen/chain/base/modules/aerodrome/decoder.py` (51 lines)
- **What:** AerodromeDecoder inherits VelodromeLikeDecoder (569 lines). Shows how to DRY protocol forks.
- **How:** Reference only (AGPL). Our Aerodrome handler extends a UniswapV3-like base class.
- **Priority:** must-have

#### From staketaxcsv -- Program-ID handler routing
- **File:** `src/staketaxcsv/sol/processor.py`
- **What:** Program-ID-based dispatch routing Solana instructions to protocol-specific handlers
- **How:** Reference for design. MIT license.
- **Priority:** must-have

### Tax engine (Phase 3)

#### From rp2 -- FIFO lot-matching algorithm
- **File:** `src/rp2/abstract_accounting_method.py` lines 191-236
- **What:** `seek_non_exhausted_acquired_lot()` -- walks acquired lots oldest-first, tracks partial amounts, advances from_index past exhausted lots for O(n) amortized performance
- **How:** Port to TS. Apache 2.0 license -- free to use.
- **Priority:** must-have (Phase 3)

#### From rp2 -- Pluggable accounting method interface
- **File:** `src/rp2/plugin/accounting_method/fifo.py`
- **What:** FIFO is 6 lines: returns `AcquiredLotCandidatesOrder.OLDER_TO_NEWER`. All complexity in base class.
- **How:** Port to TS. Apache 2.0.
- **Priority:** must-have (Phase 3)

#### From CoinTaxman -- German section 23 one-year rule
- **File:** `src/taxman.py` line 281
- **What:** `is_taxable = sc.op.utc_time + relativedelta(years=1) >= op.utc_time` -- the literal one-year holding period check per SoldCoin lot
- **How:** Reference only (AGPL). Port by reading, not copying.
- **Priority:** must-have (Phase 3)

#### From CoinTaxman -- Deposit-linked cross-platform transfers
- **File:** `src/taxman.py` lines 333+
- **What:** When a Sell draws from a Deposit, walks the `link` to the original Withdrawal and evaluates against original buy's timestamp/cost-basis. Prevents inter-wallet transfers from being taxable.
- **How:** Reference only (AGPL). Port the logic for multi-chain transfers.
- **Priority:** must-have (Phase 3)

#### From rotki -- Cost basis with Haltefrist
- **File:** `rotkehlchen/accounting/cost_basis/base.py` lines 185-293
- **What:** FIFO/LIFO walk that splits lots at the taxfree boundary. Tracks `taxfree_bought_cost` separately from `taxable_bought_cost`. `taxfree_after_period` is parameterized (not hardcoded 365 days).
- **How:** Reference only (AGPL). Reimplement in TS.
- **Priority:** must-have (Phase 3)

### Base ingest

#### From v3-subgraph -- Pre-compiled ABIs
- **File:** `~/Code/Misc/onchain/v3-subgraph/abis/NonfungiblePositionManager.json`, `pool.json`, `factory.json`
- **What:** JSON ABIs for NPM events (IncreaseLiquidity, DecreaseLiquidity, Collect) and Pool events. Drop straight into viem.
- **How:** Copy ABI files directly. GPL-3.0 applies to the subgraph mapping code, but ABI files are factual interface descriptions.
- **Priority:** must-have

#### From v3-subgraph -- Per-network config
- **File:** `~/Code/Misc/onchain/v3-subgraph/config/`
- **What:** Base factory address, NPM address, start blocks
- **How:** Copy addresses. Factual on-chain data.
- **Priority:** must-have

#### From v3-periphery -- LiquidityAmounts math
- **File:** `~/Code/Misc/onchain/v3-periphery/contracts/libraries/LiquidityAmounts.sol`
- **What:** `getAmountsForLiquidity(sqrtPriceX96, sqrtRatioAX96, sqrtRatioBX96, liquidity)` -- reference implementation of liquidity-to-token-amounts math
- **How:** Port to TS bigint arithmetic. GPL-2.0 -- reimplement from the Uniswap V3 whitepaper math.
- **Priority:** must-have

#### From @bgd-labs/aave-address-book -- Aave V3 Base contract addresses
- **File:** npm package `@bgd-labs/aave-address-book`
- **What:** All Aave V3 Base deploy addresses: Pool, UiPoolDataProvider, UiIncentiveDataProvider, PoolAddressesProvider, etc.
- **How:** Use as npm dep. Eliminates hardcoded addresses.
- **Priority:** must-have

#### From aave-utilities -- Position state snapshots
- **File:** `packages/contract-helpers/src/v3-UiPoolDataProvider-contract/index.ts`
- **What:** `UiPoolDataProvider.getUserReservesHumanized()` + `formatUserSummaryAndIncentives()` -- full Aave position state in 2 RPC calls
- **How:** Use as npm dep (`@aave/contract-helpers`, `@aave/math-utils`). MIT license. Requires ethers v5 provider alongside viem.
- **Priority:** must-have

#### From aave-utilities -- Ray math + index accrual
- **File:** `packages/math-utils/src/pool-math.ts`
- **What:** Ray (1e27) / wad (1e18) math, scaled-balance-to-actual conversion
- **How:** Use as npm dep. MIT.
- **Priority:** must-have

### Solana ingest

#### From whirlpools -- IDL JSON
- **File:** Distributed at `@orca-so/whirlpools-sdk/dist/artifacts/whirlpool.json`
- **What:** Anchor 0.32 IDL defining all Whirlpool instructions, accounts, and types
- **How:** Import from npm package at runtime. Source-available license.
- **Priority:** must-have

#### From whirlpools -- Position discovery + fee/reward quoting
- **File:** `ts-sdk/whirlpool/src/position.ts`, `ts-sdk/whirlpool/src/harvest.ts`
- **What:** `fetchPositionsForOwner()`, `collectFeesQuote()`, `collectRewardsQuote()`, `getTokenAmountsFromLiquidity()`
- **How:** Use as npm dep (`@orca-so/whirlpools`). Source-available license.
- **Priority:** must-have

#### From solana-tx-parser-public -- CPI flattener + IDL decoder
- **File:** `src/helpers.ts` (`flattenTransactionResponse`), `src/parsers.ts` (`SolanaParser`)
- **What:** Flattens inner instructions into ordered list; decodes Anchor instructions given an IDL; parses program logs
- **How:** Use as npm dep (`@debridge-finance/solana-transaction-parser`). LGPL-2.1 -- fine for CLI.
- **Priority:** must-have

#### From whirlpools -- Tick/price/liquidity math (pure TS)
- **File:** `legacy-sdk/whirlpool/src/utils/math/` and `legacy-sdk/whirlpool/src/quotes/public/collect-fees-quote.ts`
- **What:** Pure-TS fee math, tick-to-price conversion, token amounts from liquidity. Readable reference even if using the new SDK.
- **How:** Reference for verification. Source-available.
- **Priority:** nice-to-have

### Sui ingest

#### From sui-events-indexer -- Auto-generated event type definitions
- **File:** `src/services/eventExtractor.ts`, `src/services/dtoGenerator.ts`
- **What:** Run `sui-events-indexer generate -p <PACKAGE_ID>` against Turbos, Navi, and Suilend to auto-generate TypeScript interfaces for all emitted events
- **How:** Install globally (`npm i -g sui-events-indexer`), run once per protocol, harvest `types/` output. MIT.
- **Priority:** must-have

#### From suilend -- Event struct definitions
- **File:** `contracts/suilend/sources/lending_market.move`
- **What:** DepositEvent, WithdrawEvent, BorrowEvent, RepayEvent, LiquidateEvent, ClaimRewardEvent struct definitions with exact field names
- **How:** Transcribe field names into TypeScript interfaces (or verify against sui-events-indexer output). No license specified.
- **Priority:** must-have

#### From turbos-clmm-sdk -- Move call target strings + fee math
- **File:** `src/lib/pool.ts`, `src/utils/collect-fees-quote.ts`
- **What:** Exact PTB target strings (`position_manager::increase_liquidity`, `::decrease_liquidity`, `pool::collect_fee`) for tx classification. Fee/reward accrual math.
- **How:** Use as npm dep (`turbos-clmm-sdk`). MIT.
- **Priority:** must-have

#### From navi-sdk -- Pool configs + address constants
- **File:** `src/address.ts`
- **What:** Complete mapping of Navi pool configs: package IDs, pool IDs, coin types, reserve/supply/borrow object IDs for ~30 tokens
- **How:** Use as npm dep or copy address constants. Apache 2.0.
- **Priority:** must-have

### Price cache

#### From CoinTaxman -- SQLite price cache pattern
- **File:** `src/price_data.py`, `src/database.py`
- **What:** Multi-source price fetching with SQLite-backed cache. EUR spot prices.
- **How:** Reference only (AGPL). Port cache pattern to TS.
- **Priority:** nice-to-have

#### From dali-rp2 -- TransactionManifest for price batching
- **File:** `src/dali/transaction_resolver.py`
- **What:** Collects all (asset, timestamp) pairs before hitting price APIs, enabling batch optimization
- **How:** Reference for design. Apache 2.0.
- **Priority:** nice-to-have

### TUI fallback

#### From dali-rp2 -- Transaction hints system
- **File:** `src/dali/dali_main.py` lines 320-364
- **What:** `<hash> = in:interest:Aave interest` -- manual override mechanism for unclassifiable transactions
- **How:** Port pattern to TS. Apache 2.0.
- **Priority:** nice-to-have

#### From perfi -- Flag-based overrides
- **File:** `perfi/models.py` lines 45-49
- **What:** `TX_LOGICAL_FLAG` enum (unknown_send, zero_price, auto_reconciled, ignored_from_costbasis, hidden_from_8949). Non-destructive annotation instead of editing.
- **How:** Reference for design. AGPL -- reimplement.
- **Priority:** nice-to-have

---

## Architecture patterns -- consensus across repos

### 1. Canonical event/transaction model -- universal fields

Every repo's core type includes these fields:

| Field | rotki | staketaxcsv | rp2 | BittyTax | raccoin | perfi |
|---|---|---|---|---|---|---|
| timestamp | `TimestampMS` | `timestamp` | `timestamp` | `timestamp` | `timestamp` | `timestamp` |
| type/classification | `event_type + event_subtype` | `tx_type` | in/out/intra class | `TrType` | `Operation` enum | `TX_LOGICAL_TYPE` |
| asset | `Asset` | `received_currency` / `sent_currency` | `asset` | `buy.asset` / `sell.asset` | `Amount.currency` | `symbol` |
| amount | `FVal` | `received_amount` / `sent_amount` | `crypto_amount` | `buy.quantity` / `sell.quantity` | `Amount.quantity` | `amount` |
| fiat value | in extra_data or via pricing | via exporter | `spot_price * amount` | `buy.cost` / `sell.proceeds` | `value` | `price` |
| tx reference | `tx_ref` (hash) | `txid` | implicit grouping | `txid` | `tx_hash` | `tx_hash` |
| protocol/counterparty | `counterparty` | `exchange` | `exchange` | `wallet` | `blockchain` | N/A |
| notes | `notes` | `comment` | `notes` | `note` | `description` | N/A |

**Consensus:** Every model has timestamp, type, asset+amount (often split into sent/received sides), a transaction reference, and a protocol identifier. The sent/received dual-amount pattern (staketaxcsv, BittyTax) maps most naturally to Koinly's CSV format.

**Divergence:** rotki uses type x subtype (expressive but complex), staketaxcsv uses a flat enum (simple but limited), raccoin uses a tagged enum per variant (cleanest type safety). See Divergences section.

### 2. Handler dispatch -- registry vs factory vs switch

| Repo | Pattern | Description |
|---|---|---|
| rotki | Registry (self-registering) | Decoders register `addresses_to_decoders()` at init. Three-phase: address-specific -> generic rules -> post-decode |
| staketaxcsv | if/elif switch | Program-ID matching in `processor.py`. Simple, flat. |
| BittyTax | Self-registering parsers | Each `DataParser` appends itself to class-level list. Header matching for auto-detection. |
| raccoin | Compile-time distributed slice | `linkme` macro. Zero-overhead static registry. |
| dali-rp2 | Dynamic import by module path | INI config section names = fully-qualified Python module paths. Most extensible. |
| perfi | Manual routing | Hand-coded per-chain logic in `chain_to_ledger.py` |

**Consensus:** Registry pattern (rotki, BittyTax) is the most mature. Self-registration avoids a central file that must be updated for every new protocol. Rotki's three-phase dispatch (address-specific -> generic -> post-decode) is the most refined.

### 3. Pipeline stages -- raw tx to CSV row

| Repo | Stages | Description |
|---|---|---|
| perfi | 3 | chain tx -> TxLedger (token movements) -> TxLogical (classified event) |
| rotki | 2+1 | receipt logs -> decoded events (via decoder registry) -> post-decode aggregation |
| staketaxcsv | 2 | raw tx -> Row (handler produces final export-ready rows directly) |
| rp2/dali | 2 | plugin loads raw data -> RP2 does tax math (no intermediate canonical event) |
| CoinTaxman | 2 | CSV -> Operation list -> tax evaluation |

**Consensus:** The good repos have at least 2 stages. Perfi's 3-stage (raw -> ledger -> logical) is the cleanest conceptual separation. Rotki's post-decode aggregation phase is practically necessary for multi-hop swaps and router transactions.

### 4. Edge case handling

| Edge case | How handled |
|---|---|
| Failed txs | rotki: handled at TransactionDecoder level, not in protocol decoders. Others: mostly ignored. |
| Unknown methods | rotki: fall through to generic ERC-20 transfer decoding; logged not errored. perfi: flags system (unknown_send). |
| Partial fills | rotki: post_decoding_rules collapse partial fills into single events. rp2: lot splitting handles partial consumption. |
| Multi-hop swaps | rotki: router post-decoding collapses N spend+receive pairs into one. staketaxcsv: handled per-handler. |
| CPI / inner instructions | solana-tx-parser: `flattenTransactionResponse` interleaves outer + inner. staketaxcsv: balance_changes approach. |
| Native currency wrapping | rotki: detects WETH unwrap refunds, adjusts amounts. v3-periphery: WrappedTokenGatewayV3 for Aave. |

### 5. Testing strategy

| Repo | Strategy |
|---|---|
| rotki | Real tx fixtures in `tests/unit/decoders/`. Test names encode edge cases. |
| rp2 | ODS input fixtures with expected GainLoss output. Property-based validation. |
| solana-tx-parser | Real tx fixtures (`parseDlnSrcTransaction.test.ts`). Recorded actual CPI-heavy transactions. |
| staketaxcsv | Integration tests per chain using real historical tx data. |
| CoinTaxman | Limited unit tests; mostly manual verification. |

**Consensus:** The best repos use real on-chain transaction data as fixtures, not synthetic mocks. Edge cases come from actual chain weirdness and cannot be invented. Our approach: dump Felix's historical txs to JSON fixtures on day one; hand-label ~20 of the gnarliest ones as the golden test corpus.

---

## Divergences worth resolving

### 1. Event type system: flat enum vs type x subtype vs tagged union

**Options:**
- **Flat enum** (staketaxcsv, perfi): `TRADE | LP_DEPOSIT | LP_WITHDRAW | BORROW | REPAY | ...`. Simple, one dimension.
- **Type x subtype matrix** (rotki): `HistoryEventType` x `HistoryEventSubType`. ~150 valid combinations out of ~800 theoretical. Most expressive.
- **Tagged union** (raccoin): Each variant carries its own payload. Cleanest type safety in TS.

**Pick: Type x subtype matrix for internal representation; flatten to Koinly labels on export.**

Reasoning: The matrix approach (rotki) is proven to handle edge cases (e.g., TRADE+SPEND vs TRADE+RECEIVE; DEPOSIT+FEE vs WITHDRAWAL+FEE). A flat enum either gets too large (BittyTax has 31 types) or too coarse (staketaxcsv collapses distinctions). For TypeScript, implement as `{ type: EventType; subtype: EventSubType }` with a validated-pairs set. The export layer maps these to Koinly's simpler label set.

### 2. Per-platform vs global FIFO lot queue

**Options:**
- **Per-platform-per-coin** (CoinTaxman): Separate FIFO queue per (platform, coin). Deposits link to withdrawals for cross-platform transfers.
- **Global per-coin** (rp2, raccoin): One FIFO queue per asset across ALL wallets/exchanges.

**Pick: Global per-coin.** German section 23 EStG applies per-taxpayer, not per-platform. rp2's approach matches tax authority expectations. Cross-chain transfers (Base -> Solana via bridge) must not create taxable events; handle via transfer-linking (CoinTaxman's pattern).

### 3. Sent/received dual amounts vs single amount + direction

**Options:**
- **Dual amounts** (staketaxcsv, BittyTax): Separate sent and received fields. Trades fill both.
- **Single amount + direction** (rp2): Separate InTransaction/OutTransaction/IntraTransaction classes.
- **Per-event amount** (rotki): Each event in a group has one amount. A swap = two events (spend + receive) in one group.

**Pick: Dual amounts in the canonical event (matching Koinly's CSV format), with group_identifier for multi-event operations.** This is the lowest-friction path to Koinly export while preserving the grouping rotki proved necessary.

### 4. Interest accrual: per-block vs on-action

**Options:**
- **Per-block** (rotki): Track scaled balance changes to compute interest accrued between any two blocks.
- **On-action only** (CoinTaxman, perfi): Only materialize interest when a supply/withdraw/repay event occurs.

**Pick: On-action only for MVP.** Per-block tracking requires snapshots at every block the wallet was active, which is expensive for historical backfill. Interest realized at withdrawal/repay is the minimum taxable event. Perfi's approach: compute the delta between deposit and withdrawal amounts; the delta IS the interest income.

### 5. Position ID tracking

**Options:**
- No prior art tracks position IDs explicitly in the canonical event model.

**Pick: Add `positionId` as a first-class field.** The exploration doc already included this. CLMM positions (Whirlpool NFT, Uni V3 tokenId, Navi obligation, Suilend obligation) are the core domain. Every repo's model would benefit from this field but none have it because none handle CLMM to tax-grade depth. This is our novel contribution.

---

## Coverage gap map

| Our target | Best existing reference | Coverage level | What we write from scratch |
|---|---|---|---|
| Uniswap V3 (Base) | rotki V3 decoder + v3-subgraph ABIs + v3-periphery `LiquidityAmounts.sol` | **High** | Handler shell, Aerodrome address config. Rotki's Python decoder is a complete edge-case reference; ABIs drop into viem. Missing: our own tx enumeration per wallet via `getLogs`, position-to-tax-event classification, USD pricing at event time. |
| Aerodrome (Base) | rotki Aerodrome decoder (51 lines inheriting Velodrome 569 lines) | **High** | Gauge reward handling (distinct from LP fees). Slipstream NPM is a V3 fork -- same event signatures, different address. Our handler extends the Uni V3 base class. Missing: gauge staking events, veAERO rewards classification. |
| Aave V3 (Base) | aave-utilities (`formatUserSummary`) + aave-v3-core events + rotki Aave decoder | **High** | Historical event enumeration from Pool contract logs (Supply, Withdraw, Borrow, Repay, LiquidationCall). aave-utilities handles current-state snapshots. Missing: interest income computation from scaled-balance deltas, reward claim decoding from RewardsController, integration with ethers v5 alongside viem. |
| Orca Whirlpools (Solana) | whirlpools SDK + solana-tx-parser + staketaxcsv `handle_orca.py` (swaps only) | **Medium** | CLMM-specific event classification: openPosition, increaseLiquidity, decreaseLiquidity, collectFees, collectRewards, closePosition. Pairing each instruction with sibling SPL token transfers for amount extraction. Position-NFT lifecycle tracking. Compound detection (collectFees followed by increaseLiquidity). staketaxcsv handles classic swaps only, not CLMM. |
| Turbos CLMM (Sui) | turbos-clmm-sdk (state reads + Move call targets) + sui-events-indexer (type generation) | **Low** | Complete event-based historical tx decoder. SDK provides no event parsing. Must: discover all Turbos event types (via sui-events-indexer), build Move-call classifier (`position_manager::mint` -> OpenPosition, etc.), extract amounts from events or `balanceChanges`, position lifecycle tracking. |
| Navi lending (Sui) | navi-sdk (address constants only) | **Low** | Everything: event type discovery (Navi Move source NOT in repos -- must use bytecode disassembly via sui-events-indexer), deposit/borrow/repay/liquidate/claim_reward event parsing, haSUI looping pattern detection (deposit haSUI -> borrow SUI -> stake -> repeat), ctoken-to-actual amount conversion using supply indexes. |
| Suilend (Sui) | suilend Move source (event struct defs) + sui-events-indexer | **Low-Medium** | Event struct definitions are known (9 event types with clear fields). Must build: the complete TypeScript client, event query + cursor walking, event-to-tax-action mapping, ctoken amount conversion, ClaimRewardEvent handling, package ID discovery on mainnet. |
| Koinly CSV export | staketaxcsv exporter (`ExporterTypes.py:386-412`, `Exporter.py:942-964`) | **High** | Column layout and label mapping are copy-paste from staketaxcsv. Must write: our own event-to-Row mapper that handles CLMM-specific types (no prior art for how to map `lp_fee_harvest` or `lp_compound` to Koinly labels). |
| German section 23 tax math | CoinTaxman (`taxman.py:281`) + rotki (`cost_basis/base.py:185-293`) | **Medium** | Phase 3 scope. Two AGPL references exist; must clean-room reimplement. Must add: FIFO lot queue (port from rp2, Apache 2.0), one-year Haltefrist check, cross-chain transfer linking, per-lot taxable/tax-free split. No repo handles CLMM position lots (deposit USDC+SOL as two lots? as one position lot?). |
| FIFO lot matching | rp2 (`abstract_accounting_method.py:191-236`) | **High** | Phase 3. Algorithm is well-documented, Apache 2.0. Port the `seek_non_exhausted_acquired_lot` pattern. Must add: year-based method switching and German-specific Haltefrist integration on top of rp2's base. |
