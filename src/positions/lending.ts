import type { AssetTotals, PositionEventInput } from './tracker';
import { comparePositionEvents } from './tracker';

/**
 * Lending-position lifecycle reducer (WS2).
 *
 * LP positions (src/positions/tracker.ts) are keyed by an on-chain position id
 * and close on an explicit close_position event. Lending positions have no such
 * marker — a borrow/lend obligation is a running balance of collateral and
 * debt. So a lending position is derived from the protocol's `lend_*` /
 * `liquidation` events, grouped by (chain, protocol, wallet): one obligation
 * per protocol per wallet (Felix runs a single market per protocol).
 *
 * Open/close is balance-based, not event-based: the position is OPEN while any
 * net collateral (Σ supply − Σ withdraw) or net debt (Σ borrow − Σ repay) is
 * still positive, and CLOSED once both are fully unwound. Interest makes the
 * realised legs slightly exceed the principal (withdraw ≥ supply, repay ≥
 * borrow), so a fully-unwound asset nets to ≤ 0 — hence "positive net" as the
 * open signal. This is a balance-read-free heuristic: tiny dust residue could
 * keep an asset nominally open (documented limitation; no on-chain reserve
 * read offline). `lend_*` events carry no positionId; the synthetic id
 * `{chain}:{protocol}:lend:{wallet}` is assigned at rebuild time.
 */

/** Type alias (not interface) so it is assignable to the positions.state_json `Record<string, unknown>` column. */
export type LendingPositionState = {
  status: 'open' | 'closed';
  /** Cumulative collateral supplied (lend_supply:deposit), incl. auto-compounded. */
  supplied: AssetTotals;
  /**
   * Subset of `supplied` that is auto-compounded reward income (deposit flagged
   * `auto_compounded` — Suilend claim-and-restake etc.). Excluded from the
   * open/close collateral signal: the reward is already booked as income via
   * lend_reward:claim, and compounded crumbs the user never separately
   * withdraws would otherwise keep a long-closed position perpetually open.
   */
  compounded: AssetTotals;
  /** Cumulative collateral pulled back (lend_supply:withdraw + liquidation:collateral_seized). */
  withdrawn: AssetTotals;
  /** Cumulative borrowed (lend_borrow:borrow). */
  borrowed: AssetTotals;
  /** Cumulative repaid (lend_borrow:repay + liquidation:debt_repaid). */
  repaid: AssetTotals;
  /** supplied − withdrawn, positive entries only — the live collateral. */
  netCollateral: AssetTotals;
  /** borrowed − repaid, positive entries only — the live debt. */
  netDebt: AssetTotals;
  /** Cumulative lend_reward:claim income. */
  rewardsClaimed: AssetTotals;
  eventCount: number;
  lastEventAt: number;
  /** Non-destructive anomaly annotations, deterministic across rebuilds. */
  warnings: string[];
}

export interface LendingPositionSnapshot {
  positionId: string;
  chain: string;
  protocol: string;
  wallet: string;
  openedAt: number;
  closedAt: number | null;
  state: LendingPositionState;
}

/**
 * Reduce one (chain, protocol, wallet) group of lending events into a snapshot.
 * Events may be passed in any order (sorted internally). Returns undefined for
 * an empty group.
 */
export function reduceLendingPosition(
  positionId: string,
  chain: string,
  protocol: string,
  wallet: string,
  events: readonly PositionEventInput[],
): LendingPositionSnapshot | undefined {
  if (events.length === 0) return undefined;
  const sorted = [...events].sort(comparePositionEvents);

  const supplied = new Map<string, bigint>();
  const compounded = new Map<string, bigint>();
  const withdrawn = new Map<string, bigint>();
  const borrowed = new Map<string, bigint>();
  const repaid = new Map<string, bigint>();
  const rewards = new Map<string, bigint>();
  const warnings: string[] = [];
  const warn = (message: string): void => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  const openedAt = sorted[0]!.timestamp;
  let lastEventAt = 0;
  for (const event of sorted) {
    lastEventAt = event.timestamp;
    const key = `${event.type}:${event.subtype}`;
    switch (key) {
      case 'lend_supply:deposit':
        addTotal(supplied, event.sentAsset, event.sentAmount);
        if (event.flags?.includes('auto_compounded') === true) {
          addTotal(compounded, event.sentAsset, event.sentAmount);
        }
        break;
      case 'lend_supply:withdraw':
        addTotal(withdrawn, event.receivedAsset, event.receivedAmount);
        break;
      case 'lend_borrow:borrow':
        addTotal(borrowed, event.receivedAsset, event.receivedAmount);
        break;
      case 'lend_borrow:repay':
        addTotal(repaid, event.sentAsset, event.sentAmount);
        break;
      case 'lend_reward:claim':
        addTotal(rewards, event.receivedAsset, event.receivedAmount);
        break;
      case 'liquidation:collateral_seized':
        addTotal(withdrawn, event.sentAsset, event.sentAmount);
        break;
      case 'liquidation:debt_repaid':
        addTotal(repaid, event.sentAsset, event.sentAmount);
        break;
      default:
        warn(`unexpected_event:${key}:${event.txHash}`);
    }
  }

  // Open-collateral signal uses user principal only: total supplied minus
  // auto-compounded reward deposits, minus withdrawals. Withdrawals draw down
  // the whole on-chain balance (principal + compounded), so a fully-unwound
  // principal nets ≤ 0 even when compounded crumbs remain in the pool.
  const principalSupplied = new Map<string, bigint>(supplied);
  for (const [asset, amount] of compounded) {
    principalSupplied.set(asset, (principalSupplied.get(asset) ?? 0n) - amount);
  }
  const netCollateral = positiveNet(principalSupplied, withdrawn);
  const netDebt = positiveNet(borrowed, repaid);
  const open = netCollateral.size > 0 || netDebt.size > 0;

  return {
    positionId,
    chain,
    protocol,
    wallet,
    openedAt,
    closedAt: open ? null : lastEventAt,
    state: {
      status: open ? 'open' : 'closed',
      supplied: toTotals(supplied),
      compounded: toTotals(compounded),
      withdrawn: toTotals(withdrawn),
      borrowed: toTotals(borrowed),
      repaid: toTotals(repaid),
      netCollateral: toTotals(netCollateral),
      netDebt: toTotals(netDebt),
      rewardsClaimed: toTotals(rewards),
      eventCount: sorted.length,
      lastEventAt,
      warnings,
    },
  };
}

function addTotal(
  totals: Map<string, bigint>,
  asset: string | null | undefined,
  amount: bigint | null | undefined,
): void {
  if (asset === null || asset === undefined) return;
  if (amount === null || amount === undefined) return;
  totals.set(asset, (totals.get(asset) ?? 0n) + amount);
}

/** a − b per asset, keeping only strictly-positive remainders. */
function positiveNet(a: Map<string, bigint>, b: Map<string, bigint>): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const asset of new Set([...a.keys(), ...b.keys()])) {
    const value = (a.get(asset) ?? 0n) - (b.get(asset) ?? 0n);
    if (value > 0n) net.set(asset, value);
  }
  return net;
}

/** Deterministic (key-sorted) JSON-safe serialization of bigint totals. */
function toTotals(totals: Map<string, bigint>): AssetTotals {
  return Object.fromEntries(
    [...totals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([asset, amount]) => [asset, amount.toString()]),
  );
}
