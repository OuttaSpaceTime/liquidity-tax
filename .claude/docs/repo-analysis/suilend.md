# suilend

**Location:** ~/Code/Misc/defi-tracker/onchain/suilend
**Language:** Move (Sui Move)
**License:** No explicit license file (README only)
**Maintenance:** Single commit (`deployed`, 2026-03-06). No development history visible -- likely a snapshot/fork of the deployed contracts.

## Purpose
On-chain Move smart contracts for the Suilend lending protocol on Sui. Includes the core lending market, obligation (user position), reserve, oracle, liquidity mining, rate limiter, and staker modules. Also includes `sprungsui` (liquid staking wrapper) and `strategy_wrapper` contracts.

## Architecture
```
contracts/
  suilend/sources/     # Core lending protocol
    lending_market.move  # Main entry: deposit, withdraw, borrow, repay, liquidate, claim rewards
    obligation.move      # User position tracking (deposits, borrows, health factor)
    reserve.move         # Reserve/pool management, interest accrual
    reserve_config.move  # Reserve parameters (LTV, liquidation bonus, etc.)
    liquidity_mining.move # Reward distribution
    staker.move          # SUI staking integration
  oracles/             # Price oracle abstraction (Pyth, Switchboard)
  sprungsui/           # Liquid staked SUI wrapper
  strategy_wrapper/    # Strategy abstraction layer
docs/suilend/          # Per-module documentation (.md)
```

No TypeScript SDK, no client library, no examples directory. This is purely the Move contract source.

## Concrete value for our decoder
**High value as a reference for event struct definitions.** Suilend emits well-structured events for every action we need to decode:

- `DepositEvent` { lending_market_id, coin_type, reserve_id, obligation_id, ctoken_amount }
- `WithdrawEvent` { lending_market_id, coin_type, reserve_id, obligation_id, ctoken_amount }
- `BorrowEvent` { lending_market_id, coin_type, reserve_id, obligation_id, liquidity_amount, origination_fee_amount }
- `RepayEvent` { lending_market_id, coin_type, reserve_id, obligation_id, liquidity_amount }
- `LiquidateEvent` { repay/withdraw reserve_ids, obligation_id, repay/withdraw coin_types and amounts }
- `ClaimRewardEvent` { reserve_id, obligation_id, is_deposit_reward, coin_type, liquidity_amount }
- `MintEvent` / `RedeemEvent` (cToken mint/burn)
- `InterestUpdateEvent`, `ReserveAssetDataEvent` (from reserve.move)

These event structs define the exact fields our TypeScript decoder must parse from Sui's `parsedJson` event data.

**Cannot import as npm dep.** This is Move-only. We build a client using `@mysten/sui` SDK to query events by package ID.

## Integration sketch
Use the event struct definitions here as the authoritative schema for our Suilend handler. Query events via `sui_queryEvents` with `MoveEventModule` filter targeting the Suilend package ID. Map each event type (DepositEvent, BorrowEvent, etc.) to our canonical tax actions (deposit, borrow, repay, withdraw, claim_reward). The `coin_type` TypeName field resolves to the token, `liquidity_amount` gives the raw amount (needs decimal scaling from reserve config).

## Gaps
- No TypeScript SDK -- we must build the entire client from scratch using `@mysten/sui`
- No historical indexer or event query examples
- Need to discover the deployed package ID on mainnet (not in repo, only in Published.toml which may differ)
- ctoken amounts in Deposit/Withdraw events need conversion using supply index to get actual token amounts
- The haSUI looping pattern (deposit haSUI -> borrow SUI -> stake to haSUI -> repeat) is not modeled anywhere; we need to detect and unwind this from sequential events

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Direct reuse | 1/5 | Move contracts, cannot import |
| Architectural inspiration | 4/5 | Event struct definitions are exactly what we need for schema |
| Domain fit | 5/5 | This IS the protocol we're decoding |
| Maintenance health | 1/5 | Single commit, no visible dev history |
| **Overall** | **3/5** | **Essential reference for event schemas, but zero reusable code** |

## Top 3-5 files to read
- `/home/felix/Code/Misc/defi-tracker/onchain/suilend/contracts/suilend/sources/lending_market.move` -- All event struct defs + main entry points
- `/home/felix/Code/Misc/defi-tracker/onchain/suilend/contracts/suilend/sources/obligation.move` -- User position model (deposits, borrows, health factor)
- `/home/felix/Code/Misc/defi-tracker/onchain/suilend/contracts/suilend/sources/reserve.move` -- Interest accrual, InterestUpdateEvent, ReserveAssetDataEvent
- `/home/felix/Code/Misc/defi-tracker/onchain/suilend/contracts/suilend/sources/liquidity_mining.move` -- Reward distribution logic
- `/home/felix/Code/Misc/defi-tracker/onchain/suilend/contracts/sprungsui/sources/sprungsui.move` -- Liquid staked SUI, relevant for looping pattern
