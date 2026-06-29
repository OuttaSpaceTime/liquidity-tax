import type { TaxEventType } from '../types/event';

/**
 * Shared CLMM position lifecycle tracker (build-from-scratch item — see
 * `.claude/docs/repo-analysis/_synthesis.md` §"What we must build from
 * scratch" #1). No reference repo tracks concentrated-liquidity positions as
 * first-class entities; rotki's Uniswap V3 decoder
 * (`onchain/rotki/rotkehlchen/chain/evm/decoding/uniswap/v3/decoder.py`)
 * decodes individual deposits/withdrawals but keeps no lifecycle state.
 *
 * Design: a pure reducer over the position-scoped `TaxEvent` stream. State is
 * derived 100% from events, so idempotency on re-decode is structural — the
 * repo rebuilds each position from the `events` table instead of mutating
 * state incrementally, and re-applied events can never double-count.
 *
 * Lifecycle: open → increase/decrease liquidity → collect fees/rewards →
 * close. Serves Uniswap V3 (Base), Orca Whirlpool (Solana) and Turbos (Sui);
 * positionId format is `{chain}:{protocol}:{id}` (NFT token id, position
 * mint, or Sui object id).
 */

/**
 * Minimal structural view of a tax event needed for position accounting.
 * Both `TaxEvent` (decode-time, `undefined` for absent fields) and `events`
 * table rows (rebuild-time, `null` for absent fields) satisfy it.
 */
export interface PositionEventInput {
  type: TaxEventType;
  subtype: string;
  txHash: string;
  logIndex: number;
  emissionSeq?: number | null;
  timestamp: number;
  wallet: string;
  sentAsset?: string | null;
  sentAmount?: bigint | null;
  receivedAsset?: string | null;
  receivedAmount?: bigint | null;
  positionId?: string | null;
  /** Non-destructive annotations (e.g. `auto_compounded`). Used by the lending reducer; LP tracker ignores it. */
  flags?: readonly string[] | null;
}

export type PositionStatus = 'open' | 'closed';

/** Per-asset cumulative totals, bigint serialized as decimal string (JSON-safe). */
export type AssetTotals = Record<string, string>;

/**
 * Persisted into `positions.state_json`. A type alias (not interface) so it is
 * assignable to the column's `Record<string, unknown>` type.
 */
export type PositionState = {
  status: PositionStatus;
  /** Cumulative token amounts sent into the position (deposit legs). */
  deposited: AssetTotals;
  /** Cumulative principal received back (remove/close legs). */
  withdrawn: AssetTotals;
  /** deposited − withdrawn per asset; may go negative (price movement / IL). */
  principal: AssetTotals;
  /** Harvest totals from `lp_fee` events. */
  feesCollected: AssetTotals;
  /** Harvest totals from `lp_reward` events (gauge/emission claims). */
  rewardsCollected: AssetTotals;
  eventCount: number;
  lastEventAt: number;
  openTxHash: string | null;
  closeTxHash: string | null;
  /** True when history starts mid-lifecycle (position opened before ingestion window). */
  inferredOpen: boolean;
  /** Non-destructive anomaly annotations, deterministic across rebuilds. */
  warnings: string[];
};

/** Row-shaped reduction result, ready for the `positions` table. */
export interface PositionSnapshot {
  positionId: string;
  chain: string;
  protocol: string;
  wallet: string;
  openedAt: number;
  closedAt: number | null;
  state: PositionState;
}

export interface ParsedPositionId {
  chain: string;
  protocol: string;
  id: string;
}

/** Parse `{chain}:{protocol}:{id}`; the id part may itself contain colons (Sui type tags). */
export function parsePositionId(positionId: string): ParsedPositionId {
  const first = positionId.indexOf(':');
  const second = first === -1 ? -1 : positionId.indexOf(':', first + 1);
  const chain = first > 0 ? positionId.slice(0, first) : '';
  const protocol = second > first + 1 ? positionId.slice(first + 1, second) : '';
  const id = second === -1 ? '' : positionId.slice(second + 1);
  if (chain === '' || protocol === '' || id === '') {
    throw new Error(`Invalid positionId '${positionId}' — expected '{chain}:{protocol}:{id}'`);
  }
  return { chain, protocol, id };
}

/**
 * Canonical event order for reduction: block time, then tx, then on-chain log
 * order, then handler emission order. Same ordering keys the decoder registry
 * uses, with timestamp first because positions span many txs.
 */
export function comparePositionEvents(a: PositionEventInput, b: PositionEventInput): number {
  return (
    a.timestamp - b.timestamp ||
    compareStrings(a.txHash, b.txHash) ||
    a.logIndex - b.logIndex ||
    (a.emissionSeq ?? 0) - (b.emissionSeq ?? 0)
  );
}

/** Group a decoded batch by positionId; events without a positionId are skipped. */
export function groupEventsByPosition<E extends PositionEventInput>(
  events: readonly E[],
): Map<string, E[]> {
  const groups = new Map<string, E[]>();
  for (const event of events) {
    const id = event.positionId;
    if (id === null || id === undefined) continue;
    const list = groups.get(id);
    if (list === undefined) groups.set(id, [event]);
    else list.push(event);
  }
  return groups;
}

/**
 * Pure lifecycle reducer: all events of one position → snapshot. Events are
 * sorted internally, so callers may pass them in any order. Tolerant of
 * incomplete history (infers an open) and anomalous sequences (warns, never
 * throws) — except for events of a *different* position, which are a
 * programming error.
 */
export function reducePositionEvents(
  positionId: string,
  events: readonly PositionEventInput[],
): PositionSnapshot | undefined {
  if (events.length === 0) return undefined;
  const { chain, protocol } = parsePositionId(positionId);
  const sorted = [...events].sort(comparePositionEvents);

  let status: PositionStatus = 'open';
  let opened = false;
  let inferredOpen = false;
  let openedAt: number | undefined;
  let closedAt: number | null = null;
  let openTxHash: string | null = null;
  let closeTxHash: string | null = null;
  let wallet: string | undefined;
  let lastEventAt = 0;
  const warnings: string[] = [];
  const deposited = new Map<string, bigint>();
  const withdrawn = new Map<string, bigint>();
  const fees = new Map<string, bigint>();
  const rewards = new Map<string, bigint>();

  const warn = (message: string): void => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  /** First sight of a mid-lifecycle event without a recorded open. */
  const inferOpen = (event: PositionEventInput): void => {
    if (opened) return;
    opened = true;
    inferredOpen = true;
    openedAt = event.timestamp;
    openTxHash = event.txHash;
    warn(`inferred_open:${event.txHash}`);
  };
  /**
   * Events after close are normal *within the closing tx* (Uniswap close
   * multicall: decreaseLiquidity → collect → burn, so collect logs trail the
   * close); in any later tx they indicate a mislabeled close.
   */
  const warnIfAfterClose = (event: PositionEventInput, label: string): void => {
    if (status === 'closed' && event.txHash !== closeTxHash) warn(`${label}:${event.txHash}`);
  };

  for (const event of sorted) {
    if (event.positionId !== positionId) {
      throw new Error(
        `Event ${event.txHash}#${event.logIndex} belongs to position ` +
          `'${event.positionId ?? '<none>'}', not '${positionId}'`,
      );
    }
    if (wallet === undefined) wallet = event.wallet;
    else if (event.wallet !== wallet) warn(`wallet_changed:${event.txHash}`);
    lastEventAt = event.timestamp;

    switch (event.type) {
      case 'lp_deposit':
        if (event.subtype === 'open_position') {
          if (!opened) {
            opened = true;
            openedAt = event.timestamp;
            openTxHash = event.txHash;
          } else if (event.txHash !== openTxHash) {
            // Same-tx repeats are the second token leg, not a duplicate.
            if (status === 'closed') {
              warn(`reopened_after_close:${event.txHash}`);
              status = 'open';
              closedAt = null;
              closeTxHash = null;
              openTxHash = event.txHash;
            } else {
              warn(`duplicate_open:${event.txHash}`);
            }
          }
        } else {
          inferOpen(event);
          warnIfAfterClose(event, 'event_after_close');
        }
        // Deposits account the sent side only; a received side (position NFT
        // mint / LP receipt) is not principal.
        addTotal(deposited, event.sentAsset, event.sentAmount);
        break;
      case 'lp_withdraw':
        inferOpen(event);
        // Withdrawals account the received side only; a sent side (NFT burn)
        // is not principal.
        addTotal(withdrawn, event.receivedAsset, event.receivedAmount);
        if (event.subtype === 'close_position') {
          if (status === 'closed') {
            if (event.txHash !== closeTxHash) warn(`duplicate_close:${event.txHash}`);
          } else {
            status = 'closed';
            closedAt = event.timestamp;
            closeTxHash = event.txHash;
          }
        } else {
          warnIfAfterClose(event, 'event_after_close');
        }
        break;
      case 'lp_fee':
        inferOpen(event);
        warnIfAfterClose(event, 'collect_after_close');
        addTotal(fees, event.receivedAsset, event.receivedAmount);
        break;
      case 'lp_reward':
        inferOpen(event);
        warnIfAfterClose(event, 'collect_after_close');
        addTotal(rewards, event.receivedAsset, event.receivedAmount);
        break;
      default:
        warn(`unexpected_event_type:${event.type}:${event.txHash}`);
    }
  }

  const principal = new Map<string, bigint>(deposited);
  for (const [asset, amount] of withdrawn) {
    principal.set(asset, (principal.get(asset) ?? 0n) - amount);
  }

  const first = sorted[0];
  return {
    positionId,
    chain,
    protocol,
    wallet: wallet ?? first.wallet,
    openedAt: openedAt ?? first.timestamp,
    closedAt,
    state: {
      status,
      deposited: toTotals(deposited),
      withdrawn: toTotals(withdrawn),
      principal: toTotals(principal),
      feesCollected: toTotals(fees),
      rewardsCollected: toTotals(rewards),
      eventCount: sorted.length,
      lastEventAt,
      openTxHash,
      closeTxHash,
      inferredOpen,
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

/** Deterministic (key-sorted) JSON-safe serialization of bigint totals. */
function toTotals(totals: Map<string, bigint>): AssetTotals {
  return Object.fromEntries(
    [...totals.entries()]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([asset, amount]) => [asset, amount.toString()]),
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
