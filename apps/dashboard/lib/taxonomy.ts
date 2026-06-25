import type { TaxEventType } from '@lt/types/event';
import { parsePositionId } from '@lt/positions/tracker';

/** Visual category for coloring rows/badges. */
export type EventTone = 'in' | 'out' | 'income' | 'neutral' | 'warn';

export interface EventVerb {
  label: string;
  tone: EventTone;
}

/** Human verb for every (type, subtype) pair in the frozen taxonomy. */
const VERBS: Record<string, EventVerb> = {
  'transfer/send': { label: 'Sent', tone: 'out' },
  'transfer/receive': { label: 'Received', tone: 'in' },
  'transfer/self_transfer': { label: 'Self-transfer', tone: 'neutral' },
  'transfer/wrap': { label: 'Wrapped', tone: 'neutral' },
  'transfer/unwrap': { label: 'Unwrapped', tone: 'neutral' },
  'swap/trade': { label: 'Swapped', tone: 'neutral' },
  'lp_deposit/open_position': { label: 'Opened LP position', tone: 'out' },
  'lp_deposit/add_liquidity': { label: 'Added liquidity', tone: 'out' },
  'lp_withdraw/remove_liquidity': { label: 'Removed liquidity', tone: 'in' },
  'lp_withdraw/close_position': { label: 'Closed LP position', tone: 'in' },
  'lp_fee/collect': { label: 'Collected fees', tone: 'income' },
  'lp_reward/gauge_claim': { label: 'Claimed gauge rewards', tone: 'income' },
  'lp_reward/emission_claim': { label: 'Claimed emissions', tone: 'income' },
  'lend_supply/deposit': { label: 'Supplied', tone: 'out' },
  'lend_supply/withdraw': { label: 'Withdrew supply', tone: 'in' },
  'lend_borrow/borrow': { label: 'Borrowed', tone: 'in' },
  'lend_borrow/repay': { label: 'Repaid', tone: 'out' },
  'lend_interest/accrued': { label: 'Interest accrued', tone: 'income' },
  'lend_reward/claim': { label: 'Claimed lending rewards', tone: 'income' },
  'liquidation/collateral_seized': { label: 'Collateral seized', tone: 'warn' },
  'liquidation/debt_repaid': { label: 'Debt repaid (liquidation)', tone: 'warn' },
  'stake/delegate': { label: 'Staked', tone: 'out' },
  'stake/undelegate': { label: 'Unstaked', tone: 'in' },
  'stake/reward': { label: 'Staking reward', tone: 'income' },
  'bridge/out': { label: 'Bridged out', tone: 'out' },
  'bridge/in': { label: 'Bridged in', tone: 'in' },
  'gas/fee': { label: 'Gas fee', tone: 'out' },
  'unknown/needs_classification': { label: 'Needs classification', tone: 'warn' },
};

export function eventVerb(type: string, subtype: string): EventVerb {
  return VERBS[`${type}/${subtype}`] ?? { label: `${type} · ${subtype}`, tone: 'neutral' };
}

/** Event types whose received side is §22-relevant income (display hint only). */
export const INCOME_TYPES: ReadonlySet<TaxEventType> = new Set<TaxEventType>([
  'lp_fee',
  'lp_reward',
  'lend_reward',
  'lend_interest',
]);

export interface FlagMeta {
  label: string;
  tone: EventTone;
  hint: string;
}

const FLAGS: Record<string, FlagMeta> = {
  looping_pattern: { label: 'loop', tone: 'warn', hint: 'Part of a leveraged loop (e.g. haSUI re-stake).' },
  rebalance_embedded: { label: 'rebalance', tone: 'neutral', hint: 'Close+reopen embedded in one tx.' },
  bridge_out: { label: 'bridge out', tone: 'out', hint: 'Outbound leg of a cross-chain transfer.' },
  bridge_in: { label: 'bridge in', tone: 'in', hint: 'Inbound leg of a cross-chain transfer.' },
  auto_compounded: { label: 'auto-compound', tone: 'income', hint: 'Rewards auto-compounded back in.' },
  wrapped_native: { label: 'wrapped', tone: 'neutral', hint: 'Native↔wrapped native (e.g. ETH/WETH).' },
  dust: { label: 'dust', tone: 'neutral', hint: 'Negligible amount.' },
  self_transfer: { label: 'self', tone: 'neutral', hint: 'Transfer between your own wallets.' },
  flash_loan: { label: 'flash loan', tone: 'warn', hint: 'Flash-loan leg.' },
  vfat_fee: { label: 'vfat fee', tone: 'out', hint: 'vfat/Sickle fee skim — deductible expense.' },
  collect_without_same_tx_decrease: {
    label: 'collect⚠',
    tone: 'warn',
    hint: 'Fee collect with no same-tx decrease — may contain principal; verify the income split.',
  },
};

export function flagMeta(flag: string): FlagMeta {
  return FLAGS[flag] ?? { label: flag, tone: 'neutral', hint: flag };
}

/**
 * Protocol slug for an event. Prefer the positionId ({chain}:{protocol}:{id});
 * fall back to handler_id, which is itself the protocol slug (e.g.
 * 'orca_whirlpool'). `events` has no protocol column, so this is a derivation.
 */
export function protocolOf(positionId: string | null, handlerId: string): string {
  if (positionId) {
    try {
      return parsePositionId(positionId).protocol;
    } catch {
      /* fall through */
    }
  }
  return handlerId;
}
