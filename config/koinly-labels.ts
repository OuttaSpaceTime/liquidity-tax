import type { TaxEventType, SubtypeOf } from '../src/types/event';

export type KoinlyLabelMap = { [T in TaxEventType]: { [S in SubtypeOf<T>]: string } };

/** Koinly CSV label for every valid (type, subtype) pair. */
export const KOINLY_LABELS: KoinlyLabelMap = {
  transfer: {
    send: 'send',
    receive: 'receive',
    self_transfer: 'transfer',
    wrap: 'swap',
    unwrap: 'swap',
  },
  swap: {
    trade: 'swap',
  },
  lp_deposit: {
    open_position: 'add_liquidity',
    add_liquidity: 'add_liquidity',
  },
  lp_withdraw: {
    remove_liquidity: 'remove_liquidity',
    close_position: 'remove_liquidity',
  },
  lp_fee: {
    collect: 'reward',
  },
  lp_reward: {
    gauge_claim: 'reward',
    emission_claim: 'reward',
  },
  lend_supply: {
    deposit: 'add_liquidity',
    withdraw: 'remove_liquidity',
  },
  lend_borrow: {
    borrow: 'loan',
    repay: 'repay_loan',
  },
  lend_interest: {
    accrued: 'interest',
  },
  lend_reward: {
    claim: 'reward',
  },
  liquidation: {
    collateral_seized: 'realized_gain',
    debt_repaid: 'cost',
  },
  stake: {
    delegate: 'staking',
    undelegate: 'unstaking',
    reward: 'reward',
  },
  bridge: {
    out: 'send',
    in: 'receive',
  },
  gas: {
    fee: 'cost',
  },
  unknown: {
    needs_classification: '',
  },
};

export function koinlyLabel<T extends TaxEventType>(type: T, subtype: SubtypeOf<T>): string {
  return KOINLY_LABELS[type][subtype];
}
