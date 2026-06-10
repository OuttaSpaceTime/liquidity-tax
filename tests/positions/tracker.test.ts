import { describe, it, expect } from 'bun:test';
import {
  groupEventsByPosition,
  parsePositionId,
  reducePositionEvents,
} from '../../src/positions/tracker';
import { lpEvent, uniLifecycle, ORCA_POS, TURBOS_POS, UNI_POS, UNI_POS_2 } from './helpers';

describe('parsePositionId', () => {
  it('parses {chain}:{protocol}:{id}', () => {
    expect(parsePositionId(UNI_POS)).toEqual({
      chain: 'base',
      protocol: 'uniswap_v3',
      id: '813412',
    });
    expect(parsePositionId(ORCA_POS)).toEqual({
      chain: 'solana',
      protocol: 'orca_whirlpool',
      id: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    });
  });

  it('keeps colons inside the id part (Sui Move type tags)', () => {
    expect(parsePositionId('sui:turbos:0xabc::position::Position')).toEqual({
      chain: 'sui',
      protocol: 'turbos',
      id: '0xabc::position::Position',
    });
  });

  it('throws on malformed ids', () => {
    expect(() => parsePositionId('uniswap_v3:123')).toThrow();
    expect(() => parsePositionId('base::123')).toThrow();
    expect(() => parsePositionId('base:uniswap_v3:')).toThrow();
  });
});

describe('reducePositionEvents — lifecycle state machine', () => {
  it('returns undefined for an empty event list', () => {
    expect(reducePositionEvents(UNI_POS, [])).toBeUndefined();
  });

  it('throws when an event belongs to a different position', () => {
    const stray = lpEvent({ type: 'lp_fee', subtype: 'collect', positionId: UNI_POS_2 });
    expect(() => reducePositionEvents(UNI_POS, [stray])).toThrow();
  });

  it('runs the full lifecycle: open → increase → harvest → partial close → close', () => {
    const snap = reducePositionEvents(UNI_POS, uniLifecycle())!;

    expect(snap.positionId).toBe(UNI_POS);
    expect(snap.chain).toBe('base');
    expect(snap.protocol).toBe('uniswap_v3');
    expect(snap.wallet).toBe('wallet-rabby');
    expect(snap.openedAt).toBe(1_000);
    expect(snap.closedAt).toBe(5_000);

    expect(snap.state.status).toBe('closed');
    expect(snap.state.openTxHash).toBe('0xopen');
    expect(snap.state.closeTxHash).toBe('0xclose');
    expect(snap.state.inferredOpen).toBe(false);
    expect(snap.state.warnings).toEqual([]);
    expect(snap.state.eventCount).toBe(11);
    expect(snap.state.lastEventAt).toBe(5_000);

    expect(snap.state.deposited).toEqual({
      USDC: '3750000000',
      WETH: '1500000000000000000',
    });
    expect(snap.state.withdrawn).toEqual({
      USDC: '3750000000',
      WETH: '1500000000000000000',
    });
    expect(snap.state.principal).toEqual({ USDC: '0', WETH: '0' });
    expect(snap.state.feesCollected).toEqual({
      USDC: '30000000',
      WETH: '15000000000000000',
    });
    expect(snap.state.rewardsCollected).toEqual({});
  });

  it('keeps a partially closed position open with reduced principal', () => {
    // Everything up to and including the partial remove_liquidity tx.
    const snap = reducePositionEvents(UNI_POS, uniLifecycle().slice(0, 8))!;

    expect(snap.state.status).toBe('open');
    expect(snap.closedAt).toBeNull();
    expect(snap.state.closeTxHash).toBeNull();
    expect(snap.state.principal).toEqual({
      USDC: '1950000000',
      WETH: '800000000000000000',
    });
    expect(snap.state.warnings).toEqual([]);
  });

  it('applies collect + increase within one tx (auto-compound), input order independent', () => {
    const base = {
      positionId: ORCA_POS,
      chain: 'solana',
      wallet: 'wallet-phantom',
    } as const;
    const events = [
      // Deliberately out of order: the add_liquidity leg listed before the
      // collect leg that precedes it by logIndex.
      lpEvent({
        ...base,
        type: 'lp_deposit',
        subtype: 'add_liquidity',
        txHash: 'sig-compound',
        timestamp: 2_000,
        logIndex: 9,
        sentAsset: 'USDC',
        sentAmount: 50_000n,
      }),
      lpEvent({
        ...base,
        type: 'lp_fee',
        subtype: 'collect',
        txHash: 'sig-compound',
        timestamp: 2_000,
        logIndex: 5,
        receivedAsset: 'USDC',
        receivedAmount: 50_000n,
      }),
      lpEvent({
        ...base,
        type: 'lp_deposit',
        subtype: 'open_position',
        txHash: 'sig-open',
        timestamp: 1_000,
        logIndex: 1,
        sentAsset: 'USDC',
        sentAmount: 1_000_000n,
      }),
    ];

    const snap = reducePositionEvents(ORCA_POS, events)!;
    expect(snap.chain).toBe('solana');
    expect(snap.protocol).toBe('orca_whirlpool');
    expect(snap.state.status).toBe('open');
    expect(snap.state.deposited).toEqual({ USDC: '1050000' });
    expect(snap.state.feesCollected).toEqual({ USDC: '50000' });
    expect(snap.state.warnings).toEqual([]);
  });

  it('handles a rebalance as two positions: close old + open new in one tx', () => {
    const events = [
      lpEvent({
        type: 'lp_deposit',
        subtype: 'open_position',
        txHash: '0xopen',
        timestamp: 1_000,
        logIndex: 1,
        sentAsset: 'WETH',
        sentAmount: 10n,
      }),
      lpEvent({
        type: 'lp_withdraw',
        subtype: 'close_position',
        txHash: '0xrebal',
        timestamp: 5_000,
        logIndex: 10,
        receivedAsset: 'WETH',
        receivedAmount: 9n,
      }),
      lpEvent({
        type: 'lp_fee',
        subtype: 'collect',
        txHash: '0xrebal',
        timestamp: 5_000,
        logIndex: 12,
        receivedAsset: 'WETH',
        receivedAmount: 1n,
      }),
      lpEvent({
        positionId: UNI_POS_2,
        type: 'lp_deposit',
        subtype: 'open_position',
        txHash: '0xrebal',
        timestamp: 5_000,
        logIndex: 20,
        sentAsset: 'WETH',
        sentAmount: 10n,
      }),
    ];

    const groups = groupEventsByPosition(events);
    expect([...groups.keys()].sort()).toEqual([UNI_POS, UNI_POS_2].sort());

    const closed = reducePositionEvents(UNI_POS, groups.get(UNI_POS)!)!;
    expect(closed.state.status).toBe('closed');
    expect(closed.closedAt).toBe(5_000);
    expect(closed.state.feesCollected).toEqual({ WETH: '1' });
    expect(closed.state.warnings).toEqual([]);

    const reopened = reducePositionEvents(UNI_POS_2, groups.get(UNI_POS_2)!)!;
    expect(reopened.state.status).toBe('open');
    expect(reopened.openedAt).toBe(5_000);
    expect(reopened.state.deposited).toEqual({ WETH: '10' });
    expect(reopened.state.warnings).toEqual([]);
  });

  it('infers an open when history starts mid-lifecycle (pre-ingestion position)', () => {
    const snap = reducePositionEvents(TURBOS_POS, [
      lpEvent({
        positionId: TURBOS_POS,
        chain: 'sui',
        wallet: 'wallet-phantom-sui',
        type: 'lp_deposit',
        subtype: 'add_liquidity',
        txHash: 'digest-add1',
        timestamp: 9_000,
        logIndex: 0,
        sentAsset: '0x2::sui::SUI',
        sentAmount: 5n,
      }),
    ])!;

    expect(snap.chain).toBe('sui');
    expect(snap.protocol).toBe('turbos');
    expect(snap.openedAt).toBe(9_000);
    expect(snap.state.status).toBe('open');
    expect(snap.state.inferredOpen).toBe(true);
    expect(snap.state.warnings).toEqual(['inferred_open:digest-add1']);
    expect(snap.state.deposited).toEqual({ '0x2::sui::SUI': '5' });
  });

  it('warns on liquidity changes and collects after close (different tx), still applying amounts', () => {
    const snap = reducePositionEvents(UNI_POS, [
      lpEvent({
        type: 'lp_deposit',
        subtype: 'open_position',
        txHash: '0xopen',
        timestamp: 1_000,
        sentAsset: 'WETH',
        sentAmount: 1n,
      }),
      lpEvent({
        type: 'lp_withdraw',
        subtype: 'close_position',
        txHash: '0xclose',
        timestamp: 2_000,
        receivedAsset: 'WETH',
        receivedAmount: 1n,
      }),
      lpEvent({
        type: 'lp_deposit',
        subtype: 'add_liquidity',
        txHash: '0xlate1',
        timestamp: 3_000,
        sentAsset: 'WETH',
        sentAmount: 2n,
      }),
      lpEvent({
        type: 'lp_fee',
        subtype: 'collect',
        txHash: '0xlate2',
        timestamp: 4_000,
        receivedAsset: 'WETH',
        receivedAmount: 3n,
      }),
    ])!;

    expect(snap.state.status).toBe('closed');
    expect(snap.state.warnings).toEqual([
      'event_after_close:0xlate1',
      'collect_after_close:0xlate2',
    ]);
    expect(snap.state.deposited).toEqual({ WETH: '3' });
    expect(snap.state.feesCollected).toEqual({ WETH: '3' });
  });

  it('reopens (with warning) when an open_position arrives after close', () => {
    const snap = reducePositionEvents(UNI_POS, [
      lpEvent({
        type: 'lp_deposit',
        subtype: 'open_position',
        txHash: '0xopen',
        timestamp: 1_000,
        sentAsset: 'WETH',
        sentAmount: 5n,
      }),
      lpEvent({
        type: 'lp_withdraw',
        subtype: 'close_position',
        txHash: '0xclose',
        timestamp: 2_000,
        receivedAsset: 'WETH',
        receivedAmount: 5n,
      }),
      lpEvent({
        type: 'lp_deposit',
        subtype: 'open_position',
        txHash: '0xreopen',
        timestamp: 3_000,
        logIndex: 7,
        sentAsset: 'WETH',
        sentAmount: 7n,
      }),
      lpEvent({
        type: 'lp_deposit',
        subtype: 'open_position',
        txHash: '0xreopen',
        timestamp: 3_000,
        logIndex: 7,
        emissionSeq: 1,
        sentAsset: 'USDC',
        sentAmount: 9n,
      }),
    ])!;

    expect(snap.state.warnings).toEqual(['reopened_after_close:0xreopen']);
    expect(snap.state.status).toBe('open');
    expect(snap.closedAt).toBeNull();
    expect(snap.openedAt).toBe(1_000); // first open is kept
    expect(snap.state.openTxHash).toBe('0xreopen');
    expect(snap.state.deposited).toEqual({ USDC: '9', WETH: '12' });
  });

  it('warns on a duplicate open in a different tx while still open', () => {
    const snap = reducePositionEvents(UNI_POS, [
      lpEvent({
        type: 'lp_deposit',
        subtype: 'open_position',
        txHash: '0xopen',
        timestamp: 1_000,
        sentAsset: 'WETH',
        sentAmount: 5n,
      }),
      lpEvent({
        type: 'lp_deposit',
        subtype: 'open_position',
        txHash: '0xdup',
        timestamp: 2_000,
        sentAsset: 'WETH',
        sentAmount: 1n,
      }),
    ])!;

    expect(snap.state.warnings).toEqual(['duplicate_open:0xdup']);
    expect(snap.state.status).toBe('open');
    expect(snap.state.deposited).toEqual({ WETH: '6' });
  });

  it('warns on non-LP event types carrying the positionId without touching totals', () => {
    const snap = reducePositionEvents(UNI_POS, [
      lpEvent({
        type: 'lp_deposit',
        subtype: 'open_position',
        txHash: '0xopen',
        timestamp: 1_000,
        sentAsset: 'WETH',
        sentAmount: 5n,
      }),
      lpEvent({
        type: 'stake',
        subtype: 'reward',
        txHash: '0xstk',
        timestamp: 2_000,
        receivedAsset: 'AERO',
        receivedAmount: 100n,
      }),
    ])!;

    expect(snap.state.warnings).toEqual(['unexpected_event_type:stake:0xstk']);
    expect(snap.state.rewardsCollected).toEqual({});
    expect(snap.state.feesCollected).toEqual({});
    expect(snap.state.eventCount).toBe(2);
  });

  it('warns when the owning wallet changes mid-lifecycle, keeping the first wallet', () => {
    const snap = reducePositionEvents(UNI_POS, [
      lpEvent({
        type: 'lp_deposit',
        subtype: 'open_position',
        txHash: '0xopen',
        timestamp: 1_000,
        wallet: 'wallet-rabby',
        sentAsset: 'WETH',
        sentAmount: 5n,
      }),
      lpEvent({
        type: 'lp_fee',
        subtype: 'collect',
        txHash: '0xfee2',
        timestamp: 2_000,
        wallet: 'wallet-base-main-sickle',
        receivedAsset: 'WETH',
        receivedAmount: 1n,
      }),
    ])!;

    expect(snap.wallet).toBe('wallet-rabby');
    expect(snap.state.warnings).toEqual(['wallet_changed:0xfee2']);
  });

  it('is deterministic regardless of input order', () => {
    const forward = reducePositionEvents(UNI_POS, uniLifecycle());
    const reversed = reducePositionEvents(UNI_POS, [...uniLifecycle()].reverse());
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });
});
