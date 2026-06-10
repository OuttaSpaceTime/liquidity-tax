import type { EventInsert } from '../../src/db/repos/events';

/**
 * Synthetic position ids covering all three CLMM protocols the tracker must
 * serve. Synthetic event sequences are the agreed test shape for the shared
 * tracker (real-tx fixtures are a per-protocol-handler requirement).
 */
export const UNI_POS = 'base:uniswap_v3:813412';
export const UNI_POS_2 = 'base:uniswap_v3:813500';
export const ORCA_POS = 'solana:orca_whirlpool:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
export const TURBOS_POS =
  'sui:turbos:0x9f6e3b1c5a2d4e8f7a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f';

/** Builder for synthetic LP events shaped like `events` table rows. */
export function lpEvent(
  overrides: Partial<EventInsert> & Pick<EventInsert, 'type' | 'subtype'>,
): EventInsert {
  return {
    chain: 'base',
    txHash: '0xtx',
    logIndex: 0,
    emissionSeq: 0,
    timestamp: 1_700_000_000,
    wallet: 'wallet-rabby',
    positionId: UNI_POS,
    handlerId: 'test:lp',
    handlerVersion: 1,
    ...overrides,
  };
}

/**
 * Full Uniswap-style lifecycle for UNI_POS:
 * open (2 token legs) → increase → fee harvest → partial close → full close
 * with a trailing fee collect inside the closing tx (Uniswap multicall order:
 * decreaseLiquidity → collect → burn).
 */
export function uniLifecycle(): EventInsert[] {
  return [
    lpEvent({
      type: 'lp_deposit',
      subtype: 'open_position',
      txHash: '0xopen',
      timestamp: 1_000,
      logIndex: 10,
      sentAsset: 'WETH',
      sentAmount: 1_000_000_000_000_000_000n,
    }),
    lpEvent({
      type: 'lp_deposit',
      subtype: 'open_position',
      txHash: '0xopen',
      timestamp: 1_000,
      logIndex: 10,
      emissionSeq: 1,
      sentAsset: 'USDC',
      sentAmount: 2_500_000_000n,
    }),
    lpEvent({
      type: 'lp_deposit',
      subtype: 'add_liquidity',
      txHash: '0xadd',
      timestamp: 2_000,
      logIndex: 20,
      sentAsset: 'WETH',
      sentAmount: 500_000_000_000_000_000n,
    }),
    lpEvent({
      type: 'lp_deposit',
      subtype: 'add_liquidity',
      txHash: '0xadd',
      timestamp: 2_000,
      logIndex: 20,
      emissionSeq: 1,
      sentAsset: 'USDC',
      sentAmount: 1_250_000_000n,
    }),
    lpEvent({
      type: 'lp_fee',
      subtype: 'collect',
      txHash: '0xfee',
      timestamp: 3_000,
      logIndex: 30,
      receivedAsset: 'WETH',
      receivedAmount: 10_000_000_000_000_000n,
    }),
    lpEvent({
      type: 'lp_fee',
      subtype: 'collect',
      txHash: '0xfee',
      timestamp: 3_000,
      logIndex: 30,
      emissionSeq: 1,
      receivedAsset: 'USDC',
      receivedAmount: 30_000_000n,
    }),
    lpEvent({
      type: 'lp_withdraw',
      subtype: 'remove_liquidity',
      txHash: '0xpart',
      timestamp: 4_000,
      logIndex: 40,
      receivedAsset: 'WETH',
      receivedAmount: 700_000_000_000_000_000n,
    }),
    lpEvent({
      type: 'lp_withdraw',
      subtype: 'remove_liquidity',
      txHash: '0xpart',
      timestamp: 4_000,
      logIndex: 40,
      emissionSeq: 1,
      receivedAsset: 'USDC',
      receivedAmount: 1_800_000_000n,
    }),
    lpEvent({
      type: 'lp_withdraw',
      subtype: 'close_position',
      txHash: '0xclose',
      timestamp: 5_000,
      logIndex: 50,
      receivedAsset: 'WETH',
      receivedAmount: 800_000_000_000_000_000n,
    }),
    lpEvent({
      type: 'lp_withdraw',
      subtype: 'close_position',
      txHash: '0xclose',
      timestamp: 5_000,
      logIndex: 50,
      emissionSeq: 1,
      receivedAsset: 'USDC',
      receivedAmount: 1_950_000_000n,
    }),
    lpEvent({
      type: 'lp_fee',
      subtype: 'collect',
      txHash: '0xclose',
      timestamp: 5_000,
      logIndex: 55,
      receivedAsset: 'WETH',
      receivedAmount: 5_000_000_000_000_000n,
    }),
  ];
}
