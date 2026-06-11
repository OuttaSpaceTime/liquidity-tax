# Tax policy decisions

Decoder-adjacent tax policy for the German §23 (private sales) / §22 (other
income) report engine. The decoder layer records **economic facts** as
`TaxEvent`s and annotates them with non-destructive `flags[]`; the report
engine applies the policies below when computing gains. Decisions marked
**locked** were made in planning docs 03/05 — do not re-litigate in code;
revisit only with the Steuerberater.

Cross-reference: the LP-deposit policy (basis carry-forward, not a disposal)
is locked in planning doc 07 §2.2 and matches the filed 2025 report
(`liquidity-sheets/tax-report-2025/`). This file covers the lending/LST
policies from [1C.4].

## 1. LST leverage loops (haSUI / vSUI on Navi) — `looping_pattern`

**Locked ([1C.4], doc 03): re-staking borrowed SUI is NOT a disposal.**
German §23 has no definitive answer for stake-of-borrowed-funds inside an
atomic leverage loop; this is a clean-room decision to be revisited with the
Steuerberater.

The loop (wind-up direction, one PTB digest, possibly flash-loan assisted):

1. stake SUI → mint LST (Haedal `staking::UserStaked` → haSUI, or Volo
   `native_pool::StakedEvent` → vSUI)
2. deposit LST into Navi (`lending::DepositEvent`)
3. borrow SUI from Navi (`lending::BorrowEvent`)
4. repeat (or repay a same-tx flash loan that fronted step 1)

Decoder representation (`src/handlers/navi.ts`, pinned by the
`tests/fixtures/sui/navi-01` golden fixture):

- The LST mint is recorded as `swap:trade` (SUI → LST) — the on-chain fact.
- The detector flags **all constituent events** (mint swap, LST deposit, SUI
  borrow; on unwind: LST burn swap, SUI repay, LST withdraw) with
  `looping_pattern`. Flash-loan-assisted txs additionally carry `flash_loan`.

Report-engine treatment of `looping_pattern`-flagged events:

- A flagged LST mint funded by **borrowed** SUI (Navi borrow or flash loan in
  the same digest) is **not a disposal**: the SUI basis carries forward into
  the LST at the staked ratio, and no §23 gain/loss is realized.
- The **own-funds portion** of a mixed stake (e.g. navi-01: ~125 own SUI +
  ~164 flash-borrowed SUI staked in one event) is an engine-side split: the
  borrowed amounts are recoverable from the same tx's `BorrowEvent` /
  `FlashLoan` raw events. Until the engine implements the split, the
  conservative default is to treat the whole flagged mint as a carry-forward
  (consistent with the locked decision; document any deviation here).
- Flagged deposits/borrows/repays/withdraws follow §2 below unchanged — the
  flag only marks loop membership.

## 2. Lending: supply, withdraw, borrow, repay

- `lend_supply:deposit` / `lend_supply:withdraw` — **not disposals**. Supplying
  to and withdrawing from Navi keeps beneficial ownership; basis and §23
  holding period carry forward. (Same stance as LP deposits, doc 07 §2.2.)
- `lend_borrow:borrow` — **not income**. Borrowed coins arrive with a matching
  liability; their later spend/swap is a disposal of coins with basis = value
  at borrow time only if the engine models borrowed lots — default engine
  treatment: borrowed coins enter the inventory at borrow-time market value
  with a linked liability.
- `lend_borrow:repay` — **not a disposal event by itself**: returning borrowed
  coins extinguishes the liability. (If repaid with coins bought later, any
  gain/loss was realized by the acquisition/disposal that produced those
  coins, not by the repayment.)
- `lend_interest:accrued` is not emitted in the MVP; borrow interest is
  implicitly part of the repay amount.

## 3. Liquidation (decoded from the liquidated wallet's perspective)

Pinned by the `navi-02` golden fixture (foreign tx, own history has none):

- `liquidation:collateral_seized` — a **forced disposal** of the collateral at
  liquidation time. The seized amount **includes the protocol treasury cut**
  (it left the position either way). Proceeds = debt relief obtained.
- `liquidation:debt_repaid` — the debt extinguished by the liquidator
  (received side); pairs with the seizure for the engine's proceeds
  calculation.
- The liquidator side (we run no bot) is intentionally not decoded; if an
  owned wallet ever appears as liquidator the tx routes to the manual queue.

## 4. Reward claims — `lend_reward:claim`

- Income (§22) at claim time, valued at claim-time market price. Matches the
  Koinly-vocabulary `reward` label and the filed 2025 treatment of LP rewards.
- A same-tx re-deposit of the exact claimed amount is flagged
  `auto_compounded` (navi-03 fixture): the deposit is a §2 basis carry-forward
  of coins whose basis was just set by the income recognition.

## 5. Flash loans — `flash_loan`

- Borrow + repay inside one atomic PTB: **never a taxable borrow**; no
  `TaxEvent` is emitted for `flash_loan::FlashLoan`/`FlashRepay` (doc 05).
- All events the handler emits for a flash-loan-assisted tx carry the
  `flash_loan` flag. The flash fee (`FlashRepay.fee_to_supplier +
fee_to_treasury`) is paid in the repaid asset and remains visible in
  `raw_txs.raw_json`; engine may deduct it as a cost of the flagged
  transaction (default: ignored until material).

## 6. Haedal delayed unstake timing

`staking::UserNormalUnstaked` (delayed ticket) fixes both the haSUI burned and
the SUI owed at unstake time — the disposal is recognized **at the unstake
event**; the later `staking::UserClaimed` payout emits no event (avoids double
counting). Instant unstake (`UserInstantUnstaked`) is recognized directly.

## 7. LST mint/redeem outside loops

A standalone LST mint or redeem (no `looping_pattern` flag) is recorded — and
taxed — as a regular `swap:trade` disposal. LSTs are not 1:1 with their base
asset (the rate accrues staking yield; see `src/prices/token-map.ts`), so the
exchange realizes §23 gain/loss. This is the default for e.g. the cross-01
fixture's sSUI redemption; flagged loop events follow §1 instead.
