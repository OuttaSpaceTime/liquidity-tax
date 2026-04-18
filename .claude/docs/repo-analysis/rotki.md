# rotki

**Location:** ~/Code/Misc/onchain/rotki
**Language:** Python (backend), Vue (frontend -- ignore)
**License:** AGPL-3.0 (confirmed from LICENSE.md)
**Maintenance:** Active; pushed to GitHub 2026-04-13; ~3.8k stars

## Purpose

Rotki is a privacy-focused, open-source portfolio tracker and accounting tool for crypto and traditional finance. It decodes on-chain transactions into structured "history events," runs cost-basis accounting (FIFO/LIFO/HIFO/ACB), and generates tax reports for multiple jurisdictions including Germany (Section 23 EStG -- 1-year Haltefrist). It supports 20+ EVM chains and has nascent Solana support.

## Backend architecture

`rotkehlchen/` top-level directory tree (key subsystems):

| Path | Purpose |
|---|---|
| `chain/` | Per-chain managers, node inquirers, decoders, modules |
| `chain/evm/decoding/` | Shared EVM decoder infrastructure + 50+ protocol decoders |
| `chain/base/modules/` | Base-specific protocol modules (aerodrome, uniswap, aave, etc.) |
| `chain/solana/decoding/` | Solana tx decoder (SPL transfers, system program) |
| `chain/solana/modules/` | Jupiter, Jito, Pump.fun decoders |
| `chain/decoding/` | Chain-agnostic decoder base classes and interfaces |
| `accounting/` | Tax engine: accountant, cost basis, rules, PnL, export |
| `accounting/cost_basis/` | FIFO/LIFO/HIFO lot matching with Haltefrist logic |
| `history/events/structures/` | Canonical event model hierarchy |
| `db/` | SQLite schema, migrations, query builders |
| `db/schema.py` | ~1091 lines; `history_events` + `chain_events_info` tables |
| `db/upgrades/` | Schema version upgrades (v26_v27.py, v27_v28.py, etc.) |
| `data_migrations/` | Data-level migrations (separate from schema upgrades) |

### How decoders dispatch (registry pattern)

1. Each chain has a `TransactionDecoder` subclass (e.g., `EvmTransactionDecoder`).
2. On init, it loads all protocol decoder modules (one class per protocol version) via `_initialize_single_decoder()`.
3. Each decoder registers:
   - `addresses_to_decoders()` -- maps contract addresses to handler tuples
   - `decoding_rules()` -- generic rules tried on every log
   - `enricher_rules()` -- post-decode enrichment for token transfers
   - `post_decoding_rules()` -- run after all logs decoded (e.g., router aggregation)
   - `addresses_to_counterparties()` -- maps addresses to counterparty strings
4. During decoding, the main decoder iterates receipt logs, looks up `address_mappings`, falls back to generic `event_rules`, then runs enrichers and post-decoding.

This is a **registry pattern** -- not a factory. Decoders self-register their address-to-handler mappings at init time.

Importantly, the architecture is **two-level**: `chain/decoding/decoder.py` defines a chain-agnostic `TransactionDecoder` base class, which both `EvmTransactionDecoder` and Solana's decoder extend. This means the abstraction layer for adding a new chain (e.g., Sui) already exists -- rotki just hasn't implemented it. The chain-agnostic base handles event storage, progress tracking, and DB writes; the chain-specific subclass handles log/instruction parsing and module loading.

## EVM decoder pattern (Uniswap V3 end-to-end)

**File:** `rotkehlchen/chain/evm/decoding/uniswap/v3/decoder.py` (412 lines)

### Input
Decoders receive a `DecoderContext` containing:
- The parsed `EvmTxReceiptLog` (already ABI-decoded topics + data)
- The parent `EvmTransaction` metadata
- Previously decoded `EvmEvent` list (built up as logs are processed)

### How it hooks in
`Uniswapv3CommonDecoder(EvmDecoderInterface)`:
- `decoding_rules()` returns `[self._maybe_decode_v3_swap]` -- a generic rule tried on every log matching the Swap signature
- `addresses_to_decoders()` returns `{self.nft_manager: (self._decode_deposits_and_withdrawals,)}` -- only fires for NFT position manager interactions
- `post_decoding_rules()` handles router aggregation (combining multi-hop swaps into single spend/receive pairs) and LP position create/exit

### How it emits events
Decoders call `self.base.make_event()` which creates an `EvmEvent` with:
- `event_type` (e.g., `TRADE`, `DEPOSIT`, `WITHDRAWAL`)
- `event_subtype` (e.g., `SPEND`, `RECEIVE`, `DEPOSIT_ASSET`)
- `counterparty` (e.g., `"uniswap-v3"`)
- `asset`, `amount`, `notes`, `address`

Events are returned as part of `EvmDecodingOutput` or mutated in the `decoded_events` list directly.

### Edge cases handled
- **Multi-hop swaps:** Router post-decoding collapses N spend+receive pairs into one aggregated swap
- **Native currency refunds:** Detects WETH unwrap refunds and adjusts `from_amount`
- **Failed txs:** Handled at the `TransactionDecoder` level (not in protocol decoders)
- **Unknown methods:** Fall through to generic ERC-20 transfer decoding; logged but not errored

### Key file paths

| Protocol | Path |
|---|---|
| Uniswap V3 (EVM shared) | `rotkehlchen/chain/evm/decoding/uniswap/v3/decoder.py` |
| Aave V3 (EVM shared) | `rotkehlchen/chain/evm/decoding/aave/v3/decoder.py` |
| Aerodrome (Base) | `rotkehlchen/chain/base/modules/aerodrome/decoder.py` |
| Velodrome (shared base for Aerodrome) | `rotkehlchen/chain/evm/decoding/velodrome/decoder.py` |
| Solana base decoder | `rotkehlchen/chain/solana/decoding/decoder.py` |
| Solana Jupiter | `rotkehlchen/chain/solana/modules/jupiter/decoder.py` |
| Solana Jito | `rotkehlchen/chain/solana/modules/jito/decoder.py` |
| German Section 23 Haltefrist logic | `rotkehlchen/accounting/cost_basis/base.py` (lines 185-293) |

## HistoryEvent schema

The event hierarchy is:

```
HistoryBaseEntry (ABC)
  +-- OnchainEvent[T_TxRef, T_Address] (ABC, generic)
  |     +-- EvmEvent (EVM transactions)
  |     +-- SolanaEvent (Solana transactions)
  +-- HistoryEvent (off-chain: CEX trades, etc.)
  +-- AssetMovementEvent (deposits/withdrawals)
  +-- SwapEvent / EvmSwapEvent / SolanaSwapEvent
  +-- Eth2 events (staking, deposits, withdrawals)
```

### HistoryBaseEntry fields (the universal base)

```python
group_identifier: str       # shared between related events (e.g., tx hash + chain ID)
sequence_index: int         # ordering within a group
timestamp: TimestampMS      # millisecond precision
location: Location          # chain or exchange identifier
event_type: HistoryEventType       # TRADE, DEPOSIT, WITHDRAWAL, SPEND, RECEIVE, etc. (20 values)
event_subtype: HistoryEventSubType # REWARD, FEE, SPEND, RECEIVE, DEPOSIT_ASSET, etc. (40+ values)
asset: Asset                # canonical asset identifier
amount: FVal                # arbitrary-precision decimal
location_label: str | None  # user address or exchange account name
notes: str | None           # human-readable description
identifier: int | None      # DB primary key
extra_data: dict | None     # protocol-specific metadata (e.g., Maker vault ID)
```

### OnchainEvent adds

```python
tx_ref: T_TxRef             # EVMTxHash or solders.Signature
counterparty: str | None    # protocol identifier ("uniswap-v3", "aave-v3", etc.)
address: T_Address | None   # contract address or program address
```

### SQL schema (history_events table)

```sql
CREATE TABLE IF NOT EXISTS history_events (
    identifier INTEGER NOT NULL PRIMARY KEY,
    entry_type INTEGER NOT NULL,
    group_identifier TEXT NOT NULL,
    sequence_index INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    location CHAR(1) NOT NULL,
    location_label TEXT,
    asset TEXT NOT NULL,
    amount TEXT NOT NULL,
    notes TEXT,
    type TEXT NOT NULL,
    subtype TEXT NOT NULL,
    extra_data TEXT,
    ignored INTEGER NOT NULL DEFAULT 0,
    UNIQUE(group_identifier, sequence_index)
);
-- Extended by chain_events_info (tx_ref, counterparty, address)
-- Extended by eth_staking_events_info (validator_index)
```

## What to steal (reference-only, AGPL prohibits direct copy)

1. **Event type/subtype taxonomy**: The `HistoryEventType` x `HistoryEventSubType` matrix is extremely well thought out. 20 types x 40+ subtypes cover every DeFi primitive. Copy the categorization logic, not the code.

2. **`taxfree_after_period` Haltefrist implementation** (`cost_basis/base.py:185-293`): Clean algorithm -- for each spend, walk acquisitions in FIFO/LIFO order, check if `acquisition.timestamp + taxfree_after_period < sell.timestamp`. Splits lots at the taxfree boundary. Tracks `taxfree_bought_cost` separately from `taxable_bought_cost`. This is exactly what we need for Section 23.

3. **Cost basis method abstraction**: `BaseCostBasisMethod` with `FIFOCostBasisMethod` and `LIFOCostBasisMethod` subclasses using a priority heap. Clean, reusable pattern.

4. **Decoder registry pattern**: `addresses_to_decoders()` + `decoding_rules()` + `post_decoding_rules()` is an elegant three-phase dispatch. Worth copying the architecture for our TypeScript handlers.

5. **Aerodrome inherits Velodrome**: Shows how to DRY protocol forks -- `AerodromeDecoder` is 51 lines because it inherits `VelodromeLikeDecoder` (569 lines). Our handlers should share code the same way.

6. **`group_identifier` + `sequence_index`**: Groups related events (all events in one tx) and orders them. Essential for multi-event operations (LP add = spend tokenA + spend tokenB + receive LP token).

7. **MatchedAcquisition tracking**: Each spend records which acquisitions it consumed and whether each was taxable or tax-free. Critical for audit trail.

8. **Test fixtures**: Located in `rotkehlchen/tests/unit/decoders/` -- test names reveal edge cases (multi-hop swaps, partial fills, native wrapping). Can't copy, but reading test names is a free education.

## What NOT to reuse

- **User auth, premium features, API server** -- irrelevant to a CLI tool
- **Price oracle system** (`oracles/`, `inquirer.py`) -- we'll use Koinly's pricing
- **Asset database** (`globaldb/`) -- 200k+ tokens; massive and EVM-centric
- **greenlet-based concurrency** -- they use gevent; we'd use standard async/await
- **Exchange integrations** (`exchanges/`) -- CEX support is out of scope
- **Vue frontend** -- entirely irrelevant

## Solana / Sui coverage gap assessment

### Solana coverage

Rotki has **basic Solana support** with a proper decoder architecture mirroring EVM:
- Base: SPL token transfers, system program transfers, token burns/mints
- Protocols: **Jupiter** (swaps), **Jito** (staking), **Pump.fun** (token launches)
- Missing for our needs: **Orca Whirlpools** (the primary protocol we track)
- Also missing: Raydium, Meteora, Marinade, any LP position management

### Sui coverage

**Zero.** No directory, no references, no types. The `chain/` directory has no `sui/` entry.

### Coverage matrix for our target protocols

| Protocol | Chain | Rotki coverage | Gap |
|---|---|---|---|
| Uniswap V3 | Base | Full (swaps, LP, fees, liquidations) | None |
| Aerodrome | Base | Full (via Velodrome inheritance) | None |
| Aave V3 | Base | Full (supply, borrow, repay, liquidation) | None |
| Orca Whirlpools | Solana | None | Total |
| Turbos | Sui | None | Total |
| Navi | Sui | None | Total |
| Suilend | Sui | None | Total |

**Coverage: 3/7 protocols (43%).** All three covered are EVM/Base. Zero non-EVM DeFi protocol support for our target list.

This is the critical gap. Rotki covers the Base leg perfectly but contributes nothing for Solana DeFi or Sui. We cannot fork rotki and add Sui support -- we'd be maintaining a massive Python monolith for 43% coverage.

## License note

Confirmed AGPL-3.0 from `LICENSE.md`. This means:
- We **cannot** copy code into a non-AGPL project (our planned MIT/proprietary CLI)
- We **can** read, understand, and cleanly reimplement algorithms in TypeScript
- We **can** reference test fixture names and edge cases for our own test design
- If we ever distributed a modified rotki, it would have to remain AGPL

For our use case (standalone TypeScript CLI), AGPL is an **inconvenience, not a blocker**. We learn from rotki's architecture and reimplement independently.

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Code reusability | 2/5 | AGPL blocks direct reuse; Python vs TypeScript gap |
| Architectural inspiration | 5/5 | Decoder registry, event taxonomy, cost basis engine are all gold |
| Domain fit | 3/5 | EVM complete; Solana partial (no Orca); Sui zero |
| Maintenance health | 4/5 | Active development, pushed yesterday, 3.8k stars |
| **Overall** | **3.5/5** | Best-in-class EVM reference; useless for Sui; study don't fork |

## Top 5 files to read

1. **`rotkehlchen/chain/evm/decoding/decoder.py`** -- The EVM transaction decoder orchestrator. Shows how decoders register, dispatch, and compose. Our `DecoderRegistry` should mirror this.

2. **`rotkehlchen/accounting/cost_basis/base.py`** -- FIFO/LIFO cost basis with German Haltefrist. Lines 185-293 are the tax-free-after-period algorithm we need to reimplement.

3. **`rotkehlchen/history/events/structures/base.py`** -- The `HistoryBaseEntry` model. Compare against our draft `Event` type field by field.

4. **`rotkehlchen/chain/evm/decoding/uniswap/v3/decoder.py`** -- Complete Uniswap V3 decoder showing the three-phase pattern (log rules, address rules, post-decoding rules).

5. **`rotkehlchen/chain/evm/decoding/velodrome/decoder.py`** -- Velodrome/Aerodrome decoder (569 lines). Shows LP add/remove, fee claiming, gauge staking, and veNFT handling -- directly relevant to our Aerodrome tracking.
