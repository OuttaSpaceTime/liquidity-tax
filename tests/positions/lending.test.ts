import { describe, expect, test } from 'bun:test';
import { reduceLendingPosition } from '../../src/positions/lending';
import type { PositionEventInput } from '../../src/positions/tracker';

/**
 * Lending-position lifecycle reducer (WS2). Balance-based open/close: open
 * while any net collateral (Σsupply−Σwithdraw) or net debt (Σborrow−Σrepay)
 * stays positive; closed once both fully unwind (interest makes the realised
 * legs exceed principal, so a cleared asset nets ≤ 0).
 */

let seq = 0;
function ev(partial: Partial<PositionEventInput> & Pick<PositionEventInput, 'type' | 'subtype'>): PositionEventInput {
  seq += 1;
  return {
    txHash: `0xtx${seq}`,
    logIndex: 0,
    emissionSeq: 0,
    timestamp: 1_000 + seq,
    wallet: 'W',
    ...partial,
  };
}

const PID = 'solana:kamino:lend:W';

describe('reduceLendingPosition', () => {
  test('empty event set → undefined', () => {
    expect(reduceLendingPosition(PID, 'solana', 'kamino', 'W', [])).toBeUndefined();
  });

  test('supply + borrow → OPEN with net collateral and net debt', () => {
    const snap = reduceLendingPosition(PID, 'solana', 'kamino', 'W', [
      ev({ type: 'lend_supply', subtype: 'deposit', sentAsset: 'SOL', sentAmount: 4_000_000_000n }),
      ev({ type: 'lend_borrow', subtype: 'borrow', receivedAsset: 'USDC', receivedAmount: 130_000_000n }),
    ])!;
    expect(snap.state.status).toBe('open');
    expect(snap.closedAt).toBeNull();
    expect(snap.protocol).toBe('kamino');
    expect(snap.state.netCollateral).toEqual({ SOL: '4000000000' });
    expect(snap.state.netDebt).toEqual({ USDC: '130000000' });
  });

  test('partial withdraw leaves residual collateral → still OPEN', () => {
    const snap = reduceLendingPosition(PID, 'solana', 'kamino', 'W', [
      ev({ type: 'lend_supply', subtype: 'deposit', sentAsset: 'SOL', sentAmount: 4_000_000_000n }),
      ev({ type: 'lend_supply', subtype: 'withdraw', receivedAsset: 'SOL', receivedAmount: 300_000_000n }),
    ])!;
    expect(snap.state.status).toBe('open');
    expect(snap.state.netCollateral).toEqual({ SOL: '3700000000' });
  });

  test('full unwind (withdraw≥supply, repay≥borrow with interest) → CLOSED at last event', () => {
    const events = [
      ev({ type: 'lend_supply', subtype: 'deposit', sentAsset: 'SOL', sentAmount: 100n }),
      ev({ type: 'lend_borrow', subtype: 'borrow', receivedAsset: 'USDC', receivedAmount: 100n }),
      ev({ type: 'lend_borrow', subtype: 'repay', sentAsset: 'USDC', sentAmount: 103n }),
      ev({ type: 'lend_supply', subtype: 'withdraw', receivedAsset: 'SOL', receivedAmount: 105n }),
    ];
    const snap = reduceLendingPosition(PID, 'solana', 'kamino', 'W', events)!;
    expect(snap.state.status).toBe('closed');
    expect(snap.state.netCollateral).toEqual({});
    expect(snap.state.netDebt).toEqual({});
    expect(snap.closedAt).toBe(events[events.length - 1]!.timestamp);
  });

  test('auto_compounded reward deposit does NOT keep a position open (no real principal/debt)', () => {
    // Suilend claim-and-restake: the reward is income (claim) AND compounds
    // back into the pool (deposit, flagged auto_compounded). The compounded
    // crumb must not count as user-managed open collateral.
    const snap = reduceLendingPosition(PID, 'sui', 'suilend', 'W', [
      ev({ type: 'lend_reward', subtype: 'claim', receivedAsset: 'DEEP', receivedAmount: 100n }),
      ev({
        type: 'lend_supply',
        subtype: 'deposit',
        sentAsset: 'DEEP',
        sentAmount: 100n,
        flags: ['auto_compounded'],
      }),
    ])!;
    expect(snap.state.status).toBe('closed');
    expect(snap.state.netCollateral).toEqual({});
    expect(snap.state.compounded).toEqual({ DEEP: '100' });
    expect(snap.state.rewardsClaimed).toEqual({ DEEP: '100' });
  });

  test('real supply later withdrawn → closed, even with auto_compounded crumbs left in pool', () => {
    const snap = reduceLendingPosition(PID, 'sui', 'suilend', 'W', [
      ev({ type: 'lend_supply', subtype: 'deposit', sentAsset: 'SUI', sentAmount: 1_000n }),
      ev({ type: 'lend_reward', subtype: 'claim', receivedAsset: 'DEEP', receivedAmount: 5n }),
      ev({
        type: 'lend_supply',
        subtype: 'deposit',
        sentAsset: 'DEEP',
        sentAmount: 5n,
        flags: ['auto_compounded'],
      }),
      ev({ type: 'lend_supply', subtype: 'withdraw', receivedAsset: 'SUI', receivedAmount: 1_001n }),
    ])!;
    expect(snap.state.status).toBe('closed');
    expect(snap.state.netCollateral).toEqual({});
  });

  test('a real (non-compounded) supply still keeps the position open', () => {
    const snap = reduceLendingPosition(PID, 'sui', 'suilend', 'W', [
      ev({ type: 'lend_supply', subtype: 'deposit', sentAsset: 'SUI', sentAmount: 1_000n }),
    ])!;
    expect(snap.state.status).toBe('open');
    expect(snap.state.netCollateral).toEqual({ SUI: '1000' });
  });

  test('reward claim is income only — does not affect open/close', () => {
    const snap = reduceLendingPosition(PID, 'base', 'morpho', 'W', [
      ev({ type: 'lend_supply', subtype: 'deposit', sentAsset: 'WETH', sentAmount: 1_000n }),
      ev({ type: 'lend_borrow', subtype: 'borrow', receivedAsset: 'USDC', receivedAmount: 500n }),
      ev({ type: 'lend_reward', subtype: 'claim', receivedAsset: 'MORPHO', receivedAmount: 7n }),
    ])!;
    expect(snap.state.status).toBe('open');
    expect(snap.state.rewardsClaimed).toEqual({ MORPHO: '7' });
  });
});
