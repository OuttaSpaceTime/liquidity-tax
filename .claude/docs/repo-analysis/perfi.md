# perfi

**Location:** ~/Code/Misc/onchain/perfi
**Language:** Python
**License:** AGPL-3.0
**Maintenance:** Last commit 2025-12-26 (tax locking concept). Low activity; appears to be a solo dev project.

## Purpose
Ethereum-focused DeFi-aware tax tool with a 3-stage pipeline: chain transactions -> ledger transactions -> logical transactions -> cost basis. SQLite storage with web API. Generates IRS Form 8949.

## Architecture
- **3-stage pipeline:**
  1. `ingest/chain.py` -- scrapes on-chain transactions via Etherscan/block explorers, stores raw data as `tx_chain` in SQLite
  2. `transaction/chain_to_ledger.py` -- decodes raw chain txs into `TxLedger` entries (individual token movements with direction, amount, price)
  3. `transaction/ledger_to_logical.py` -- groups ledger entries into `TxLogical` (high-level operations: swap, lp, borrow, deposit, etc.)
- **Logical tx types:** `models.py::TX_LOGICAL_TYPE` -- borrow, repay, deposit, withdraw, disposal, lp, swap, yield, mint, gift, airdrop, trade, self_transfer, receive, send, income, approval
- **Flags system:** `models.py::TX_LOGICAL_FLAG` -- unknown_send, zero_price, auto_reconciled, ignored_from_costbasis, hidden_from_8949. Stored in SQLite `flag` table
- **Cost basis:** `costbasis.py` -- FIFO lot matching with `CostbasisLot` and `CostbasisDisposal` models
- **SQLite throughout:** All state persisted in SQLite. Ledger, logical, cost basis, flags, prices
- **Price feed:** `price.py` -- CoinGecko-based price resolution
- **Chain support:** `models.py::Chain` -- Ethereum only + exchange imports (Coinbase, Kraken, Gemini, BitcoinTax)

## What to steal / reuse
- **3-stage pipeline design** (chain -> ledger -> logical) in the `transaction/` directory: this is exactly the architecture our decoder needs (raw tx -> token movements -> classified DeFi event)
- **TX_LOGICAL_TYPE enum** in `perfi/models.py` lines 24-41: the `lp` type alongside `borrow`, `repay`, `deposit`, `withdraw` -- good reference for our event type taxonomy
- **Flags system** in `perfi/models.py` lines 45-49: marking transactions as auto_reconciled or ignored_from_costbasis is a pattern we'll need for edge cases
- **TransactionLogicalGrouper** in `perfi/transaction/ledger_to_logical.py`: groups individual token movements by tx hash into logical operations

## What to learn from (architectural inspiration)
- **Chain -> Ledger -> Logical pipeline:** The cleanest separation of concerns among all repos. Raw chain data is never mixed with tax-classified events. Each stage has clear inputs and outputs
- **SQLite as persistence layer:** Using SQLite instead of in-memory structures means intermediate results survive crashes and enable incremental processing. Good fit for our CLI tool
- **Flag-based overrides:** Instead of editing transactions, flags annotate them. Non-destructive and auditable
- **Event-sourcing pattern:** `events.py::EventStore` with `EVENT_ACTION` enum tracks what happened to each transaction

## Gaps for our use case
- **Ethereum only:** No Solana, no Sui, no Base (despite being EVM). Chain enum is hardcoded
- **No DeFi protocol decoders:** Despite having the pipeline, actual protocol decoding (Uniswap, Aave, etc.) appears minimal. The grouper is generic
- **US-focused:** Form 8949 output, US/Pacific timezone default. No German tax rules
- **AGPL license:** Restrictive for reuse
- **Low maintenance:** Solo dev, slow progress. Last substantive feature was "tax locking" concept
- **No Koinly output:** Generates Form 8949, not Koinly CSV

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Code reusability | 2/5 | Pipeline concept is great but implementation is tightly coupled to Ethereum/SQLite |
| Architectural inspiration | 4/5 | Best chain->ledger->logical pipeline design in the group |
| Domain fit | 2/5 | Ethereum-only, US-only, minimal DeFi protocol support |
| Maintenance health | 1/5 | Very low activity, solo project |
| **Overall** | **2/5** | **Architectural inspiration for 3-stage pipeline, not much to port directly** |

## Top 3 files to read
1. `perfi/models.py` -- TX_LOGICAL_TYPE enum, TX_LOGICAL_FLAG, Chain enum, CostbasisLot/CostbasisDisposal models
2. `perfi/transaction/chain_to_ledger.py` -- Stage 2: how raw chain txs become ledger entries with token movements
3. `perfi/transaction/ledger_to_logical.py` -- Stage 3: TransactionLogicalGrouper that classifies ledger entries into logical operations
