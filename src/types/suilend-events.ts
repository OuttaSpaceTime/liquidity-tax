/**
 * Suilend — Move event types (Sui mainnet). All 13 events enumerated
 * ([1C.1] done-criterion), verified two ways: against the published Move
 * source (onchain/suilend/contracts/suilend/sources/{lending_market,
 * obligation, reserve}.move) AND against deployed bytecode + real sampled
 * mainnet events (U0 spike, 2026-06-11).
 *
 * parsedJson rendering rules: see header of turbos-events.ts. Suilend-specific:
 *   - 0x1::type_name::TypeName -> { name: string } (NO "0x" prefix on name)
 *   - suilend::decimal::Decimal -> { value: string }, fixed-point scaled 1e18
 *     (WAD); e.g. price { value: "999870930000000000" } ~= 0.99987.
 *
 * ctoken caveat: Deposit/Withdraw events carry CTOKEN amounts; convert to
 * underlying via the reserve exchange rate (ctoken_supply vs supply_amount
 * from the same-tx ReserveAssetDataEvent, or Mint/Redeem events which carry
 * both sides).
 */

/**
 * Original package (Published.toml original-id) — the DEFINING ID for 12 of
 * the 13 event types; emitted `type` strings carry this address regardless of
 * the executing package version. Confirmed by sampling (e.g. RedeemEvent +
 * LiquidateEvent on tx 8Kk8xsRt26rb7gU5ptbsRtc2woPK1USFv4daHZQ1e1YJ).
 */
export const SUILEND_PACKAGE_ORIGINAL =
  '0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf';
/**
 * Latest published package (Published.toml published-at, version 20). Use for
 * MoveModule queryEvents filters and normalized-module lookups — filtering on
 * the original package returns nothing for current emissions.
 */
export const SUILEND_PACKAGE_CURRENT =
  '0x3d4353f3bd3565329655e6b77bc2abfd31e558b86662ebd078ae453d416bc10f';
/** The main Suilend lending market object (observed in every sampled event). */
export const SUILEND_MAIN_MARKET_ID =
  '0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1';

/** 0x1::type_name::TypeName as rendered in parsedJson. `name` lacks the 0x prefix. */
export interface SuilendTypeName {
  name: string;
}

/** suilend::decimal::Decimal as rendered in parsedJson — 1e18 fixed-point decimal string. */
export interface SuilendDecimal {
  value: string;
}

// ---------------------------------------------------------------------------
// lending_market module (9 events)
// ---------------------------------------------------------------------------

/** Underlying deposited -> ctokens minted. Tax: half of lend_supply/deposit (carries BOTH amounts). */
export interface SuilendMintEvent {
  lending_market_id: string;
  coin_type: SuilendTypeName;
  reserve_id: string;
  liquidity_amount: string;
  ctoken_amount: string;
}

/** ctokens burned -> underlying returned. Tax: half of lend_supply/withdraw. */
export interface SuilendRedeemEvent {
  lending_market_id: string;
  coin_type: SuilendTypeName;
  reserve_id: string;
  ctoken_amount: string;
  liquidity_amount: string;
}

/** ctokens deposited into an obligation as collateral. Tax: lend_supply/deposit (ctoken units!). */
export interface SuilendDepositEvent {
  lending_market_id: string;
  coin_type: SuilendTypeName;
  reserve_id: string;
  obligation_id: string;
  ctoken_amount: string;
}

/** ctokens withdrawn from an obligation. Tax: lend_supply/withdraw (ctoken units!). */
export interface SuilendWithdrawEvent {
  lending_market_id: string;
  coin_type: SuilendTypeName;
  reserve_id: string;
  obligation_id: string;
  ctoken_amount: string;
}

/** Borrow (amount includes origination fee). Tax: lend_borrow/borrow. */
export interface SuilendBorrowEvent {
  lending_market_id: string;
  coin_type: SuilendTypeName;
  reserve_id: string;
  obligation_id: string;
  liquidity_amount: string;
  origination_fee_amount: string;
}

/** Repay. Tax: lend_borrow/repay. */
export interface SuilendRepayEvent {
  lending_market_id: string;
  coin_type: SuilendTypeName;
  reserve_id: string;
  obligation_id: string;
  liquidity_amount: string;
}

/** Bad debt written off by protocol (not user-initiated). */
export interface SuilendForgiveEvent {
  lending_market_id: string;
  coin_type: SuilendTypeName;
  reserve_id: string;
  obligation_id: string;
  liquidity_amount: string;
}

/** Liquidation. Tax: liquidation/* when obligation belongs to an owned wallet. */
export interface SuilendLiquidateEvent {
  lending_market_id: string;
  repay_reserve_id: string;
  withdraw_reserve_id: string;
  obligation_id: string;
  repay_coin_type: SuilendTypeName;
  withdraw_coin_type: SuilendTypeName;
  repay_amount: string;
  withdraw_amount: string;
  protocol_fee_amount: string;
  liquidator_bonus_amount: string;
}

/** Liquidity-mining reward claim. Tax: lend_reward/claim. */
export interface SuilendClaimRewardEvent {
  lending_market_id: string;
  reserve_id: string;
  obligation_id: string;
  is_deposit_reward: boolean;
  pool_reward_id: string;
  coin_type: SuilendTypeName;
  liquidity_amount: string;
}

// ---------------------------------------------------------------------------
// obligation module (1 event)
// ---------------------------------------------------------------------------

export interface SuilendDepositRecord {
  coin_type: SuilendTypeName;
  reserve_array_index: string;
  deposited_ctoken_amount: string;
  market_value: SuilendDecimal;
  user_reward_manager_index: string;
  /** unused upstream */
  attributed_borrow_value: SuilendDecimal;
}

export interface SuilendBorrowRecord {
  coin_type: SuilendTypeName;
  reserve_array_index: string;
  borrowed_amount: SuilendDecimal;
  cumulative_borrow_rate: SuilendDecimal;
  market_value: SuilendDecimal;
  user_reward_manager_index: string;
}

/** Full obligation snapshot, emitted after obligation-touching actions. Not a TaxEvent source; useful for validation. */
export interface SuilendObligationDataEvent {
  lending_market_id: string;
  obligation_id: string;
  deposits: SuilendDepositRecord[];
  borrows: SuilendBorrowRecord[];
  deposited_value_usd: SuilendDecimal;
  allowed_borrow_value_usd: SuilendDecimal;
  unhealthy_borrow_value_usd: SuilendDecimal;
  /** unused upstream */
  super_unhealthy_borrow_value_usd: SuilendDecimal;
  unweighted_borrowed_value_usd: SuilendDecimal;
  weighted_borrowed_value_usd: SuilendDecimal;
  weighted_borrowed_value_upper_bound_usd: SuilendDecimal;
  borrowing_isolated_asset: boolean;
  bad_debt_usd: SuilendDecimal;
  closable: boolean;
}

// ---------------------------------------------------------------------------
// reserve module (3 events)
// ---------------------------------------------------------------------------

/** Interest accrual tick (protocol-level, every compound). Source for lend_interest if ever needed. */
export interface SuilendInterestUpdateEvent {
  lending_market_id: string;
  coin_type: SuilendTypeName;
  reserve_id: string;
  cumulative_borrow_rate: SuilendDecimal;
  available_amount: string;
  borrowed_amount: SuilendDecimal;
  unclaimed_spread_fees: SuilendDecimal;
  ctoken_supply: string;
  borrow_interest_paid: SuilendDecimal;
  spread_fee: SuilendDecimal;
  supply_interest_earned: SuilendDecimal;
  borrow_interest_paid_usd_estimate: SuilendDecimal;
  protocol_fee_usd_estimate: SuilendDecimal;
  supply_interest_earned_usd_estimate: SuilendDecimal;
}

/** Reserve state snapshot (emitted alongside most actions). Source for ctoken<->underlying exchange rate + USD prices. */
export interface SuilendReserveAssetDataEvent {
  lending_market_id: string;
  coin_type: SuilendTypeName;
  reserve_id: string;
  available_amount: SuilendDecimal;
  supply_amount: SuilendDecimal;
  borrowed_amount: SuilendDecimal;
  available_amount_usd_estimate: SuilendDecimal;
  supply_amount_usd_estimate: SuilendDecimal;
  borrowed_amount_usd_estimate: SuilendDecimal;
  borrow_apr: SuilendDecimal;
  supply_apr: SuilendDecimal;
  ctoken_supply: string;
  cumulative_borrow_rate: SuilendDecimal;
  price: SuilendDecimal;
  smoothed_price: SuilendDecimal;
  price_last_update_timestamp_s: string;
}

/**
 * Protocol staking rewards claimed into the SUI reserve (staker module).
 * Protocol-level, not user-addressed — no TaxEvent. Added in a later package
 * upgrade: NOT defined at the original package (MoveEventType probes at both
 * original and v20 returned nothing) — match by `::reserve::ClaimStakingRewardsEvent`
 * suffix if ever needed.
 */
export interface SuilendClaimStakingRewardsEvent {
  lending_market_id: string;
  coin_type: SuilendTypeName;
  reserve_id: string;
  amount: string;
}

/** 12 of 13 event types carry the original package as defining ID. */
export const SUILEND_EVENT_TYPES = {
  mint: `${SUILEND_PACKAGE_ORIGINAL}::lending_market::MintEvent`,
  redeem: `${SUILEND_PACKAGE_ORIGINAL}::lending_market::RedeemEvent`,
  deposit: `${SUILEND_PACKAGE_ORIGINAL}::lending_market::DepositEvent`,
  withdraw: `${SUILEND_PACKAGE_ORIGINAL}::lending_market::WithdrawEvent`,
  borrow: `${SUILEND_PACKAGE_ORIGINAL}::lending_market::BorrowEvent`,
  repay: `${SUILEND_PACKAGE_ORIGINAL}::lending_market::RepayEvent`,
  forgive: `${SUILEND_PACKAGE_ORIGINAL}::lending_market::ForgiveEvent`,
  liquidate: `${SUILEND_PACKAGE_ORIGINAL}::lending_market::LiquidateEvent`,
  claimReward: `${SUILEND_PACKAGE_ORIGINAL}::lending_market::ClaimRewardEvent`,
  obligationData: `${SUILEND_PACKAGE_ORIGINAL}::obligation::ObligationDataEvent`,
  interestUpdate: `${SUILEND_PACKAGE_ORIGINAL}::reserve::InterestUpdateEvent`,
  reserveAssetData: `${SUILEND_PACKAGE_ORIGINAL}::reserve::ReserveAssetDataEvent`,
} as const;

export type SuilendEventType = (typeof SUILEND_EVENT_TYPES)[keyof typeof SUILEND_EVENT_TYPES];

/** Defining ID unconfirmed (introduced by an intermediate upgrade) — suffix-match. */
export const SUILEND_EVENT_TYPE_SUFFIXES = {
  claimStakingRewards: '::reserve::ClaimStakingRewardsEvent',
} as const;

export interface SuilendEventPayloadMap {
  mint: SuilendMintEvent;
  redeem: SuilendRedeemEvent;
  deposit: SuilendDepositEvent;
  withdraw: SuilendWithdrawEvent;
  borrow: SuilendBorrowEvent;
  repay: SuilendRepayEvent;
  forgive: SuilendForgiveEvent;
  liquidate: SuilendLiquidateEvent;
  claimReward: SuilendClaimRewardEvent;
  obligationData: SuilendObligationDataEvent;
  interestUpdate: SuilendInterestUpdateEvent;
  reserveAssetData: SuilendReserveAssetDataEvent;
  claimStakingRewards: SuilendClaimStakingRewardsEvent;
}
