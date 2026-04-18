# sui-tx-explainer

**Location:** ~/Code/Misc/defi-tracker/onchain/sui-tx-explainer
**Language:** TypeScript (Next.js 16 + React 19)
**License:** No explicit license file ("open source and available for use and modification" per README)
**Maintenance:** Single commit (2026-01-29, "Add website link to README"). Minimal development history.

## Purpose
A web application that translates Sui transaction data into human-readable explanations. Takes a Sui transaction digest, fetches the full transaction block, and produces structured actions (COIN_TRANSFER, NFT_TRANSFER, MOVE_CALL, OBJECT_CREATED, STAKING, SWAP) with plain-English descriptions. Deployed at suitx-explainer.vercel.app.

## Architecture
```
src/app/
  api/explain/[txHash]/route.ts  # ALL logic lives here (~540 lines)
  page.tsx                        # Frontend UI
  layout.tsx                      # Root layout
  globals.css                     # Tailwind styles
```

The entire decoding engine is a single API route file. It:
1. Validates the transaction digest (hex or base58)
2. Fetches full transaction block via `SuiClient.getTransactionBlock()` with all options enabled (showInput, showEffects, showEvents, showObjectChanges, showBalanceChanges)
3. Parses coin transfers from events (looks for events with "Transfer" in the type)
4. Classifies actions from objectChanges and ProgrammableTransaction commands
5. Generates human-readable explanations

## Concrete value for our decoder

**Low.** The approach is generic but shallow. It demonstrates the correct Sui RPC call pattern but doesn't do protocol-specific semantic interpretation.

What it shows:
- How to fetch a full Sui transaction with all data (`showEvents: true`, `showObjectChanges: true`, `showBalanceChanges: true`)
- How to extract Move calls from ProgrammableTransaction commands (`cmd.MoveCall.package`, `.module`, `.function`)
- How to parse coin transfers from events
- Gas cost extraction pattern

What it cannot do:
- **No protocol-specific decoding.** Does not interpret Suilend deposits, Navi borrows, Turbos LP operations, etc. All Move calls are reported as generic `called module::function` without semantic meaning.
- **No argument decoding.** Identifies that a Move call happened but not what amounts/parameters were passed.
- **No token amount resolution from events.** Coin transfers are only detected from explicit Transfer events, not from protocol-specific events like DepositEvent or BorrowEvent.
- **Hardcoded maps are minimal.** `KNOWN_COINS` has 3 entries (SUI, USDC, USDT). `KNOWN_CONTRACTS` has 3 entries (Sui Framework, DeepBook, Sui System).
- **Not importable.** It's a Next.js web app, not a library. To reuse, you'd extract ~300 lines from the route handler.

The hard part of our decoder (mapping protocol-specific events to tax-relevant actions with correct amounts and token types) is exactly what this tool does NOT do.

## Integration sketch
Not worth integrating directly. The useful patterns (SuiClient.getTransactionBlock with full options, ProgrammableTransaction command iteration) are better reimplemented cleanly in our decoder. The ~20 lines of transaction-fetching boilerplate it demonstrates are trivial to write from the `@mysten/sui` SDK docs.

## Gaps
- Everything protocol-specific -- this is a generic, surface-level explainer
- No event-type-aware parsing (ignores all protocol events except generic Transfer)
- No argument decoding for Move calls
- No batch/historical processing -- single transaction at a time
- Not structured for extraction as a library

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Direct reuse | 1/5 | Web app, not a library; logic too shallow to extract |
| Architectural inspiration | 2/5 | Shows correct Sui RPC call pattern, but that's in the SDK docs too |
| Domain fit | 2/5 | Generic tx explanation, not DeFi tax decoding |
| Maintenance health | 1/5 | Single commit, minimal project |
| **Overall** | **1/5** | **Minimal value; the Sui SDK docs are more useful** |

## Top 3-5 files to read
- `/home/felix/Code/Misc/defi-tracker/onchain/sui-tx-explainer/src/app/api/explain/[txHash]/route.ts` -- Entire decoding logic (the only substantive file)
