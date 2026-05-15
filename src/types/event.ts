export type Chain = 'base' | 'solana' | 'sui';
export type Protocol =
  | 'uniswap_v3'
  | 'aerodrome'
  | 'aave_v3'
  | 'orca_whirlpool'
  | 'turbos'
  | 'navi'
  | 'suilend'
  | 'native';

/** Frozen 15-type event taxonomy. Values are valid subtypes per type. */
export type TaxEventMap = {
  transfer: 'send' | 'receive' | 'self_transfer' | 'wrap' | 'unwrap';
  swap: 'trade';
  lp_deposit: 'open_position' | 'add_liquidity';
  lp_withdraw: 'remove_liquidity' | 'close_position';
  lp_fee: 'collect';
  lp_reward: 'gauge_claim' | 'emission_claim';
  lend_supply: 'deposit' | 'withdraw';
  lend_borrow: 'borrow' | 'repay';
  /** Reserved — not emitted in MVP; present for completeness and lend_interest CSV rows. */
  lend_interest: 'accrued';
  lend_reward: 'claim';
  liquidation: 'collateral_seized' | 'debt_repaid';
  stake: 'delegate' | 'undelegate' | 'reward';
  /** Reserved — populated by Phase 1D transfer linker. */
  bridge: 'out' | 'in';
  gas: 'fee';
  unknown: 'needs_classification';
};

export type TaxEventType = keyof TaxEventMap;
export type SubtypeOf<T extends TaxEventType> = TaxEventMap[T];

export type Flag =
  | 'looping_pattern'
  | 'rebalance_embedded'
  | 'bridge_out'
  | 'bridge_in'
  | 'auto_compounded'
  | 'wrapped_native'
  | 'dust'
  | 'self_transfer'
  | 'flash_loan';

export type PositionId = `${Chain}:${Protocol}:${string}`;

/**
 * Canonical tax event. Generic on T so that `subtype` is narrowed to the valid
 * subtypes for that event type — invalid pairs fail `tsc --noEmit`.
 */
export interface TaxEvent<T extends TaxEventType = TaxEventType> {
  type: T;
  subtype: SubtypeOf<T>;
  chain: Chain;
  txHash: string;
  logIndex: number;
  emissionSeq: number;
  timestamp: number;
  wallet: string;
  sentAsset?: string;
  sentAmount?: bigint;
  receivedAsset?: string;
  receivedAmount?: bigint;
  priceUsd?: { sent?: string; received?: string; source: string };
  positionId?: PositionId;
  flags?: Flag[];
  handlerId: string;
  handlerVersion: number;
}
