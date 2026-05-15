import type { TaxEvent, TaxEventType, SubtypeOf, Flag } from '../../src/types/event';

// --- Valid pairs: must compile without errors ---

const _v1: SubtypeOf<'swap'>        = 'trade';
const _v2: SubtypeOf<'lp_fee'>      = 'collect';
const _v3: SubtypeOf<'transfer'>    = 'send';
const _v4: SubtypeOf<'gas'>         = 'fee';
const _v5: SubtypeOf<'liquidation'> = 'collateral_seized';
const _v6: Flag                     = 'looping_pattern';

const _validSwap: TaxEvent<'swap'> = {
  type: 'swap',
  subtype: 'trade',
  chain: 'base',
  txHash: '0xabc',
  logIndex: 0,
  emissionSeq: 0,
  timestamp: 1_700_000_000,
  wallet: '0xwallet',
  handlerId: 'uniswap_v3',
  handlerVersion: 1,
};

// --- Invalid pairs: @ts-expect-error guards —
//     If the constraint disappears, tsc reports "Unused @ts-expect-error" (error 2578). ---

// @ts-expect-error — 'gauge_claim' is not assignable to SubtypeOf<'lp_fee'> ('collect')
const _i1: SubtypeOf<'lp_fee'> = 'gauge_claim';

// @ts-expect-error — 'receive' is not assignable to SubtypeOf<'swap'> ('trade')
const _i2: SubtypeOf<'swap'> = 'receive';

// @ts-expect-error — 'trade' is a subtype, not a TaxEventType key
const _i3: TaxEventType = 'trade';

// @ts-expect-error — 'invalid_flag' is not a valid Flag
const _i4: Flag = 'invalid_flag';

// Full TaxEvent object with wrong subtype — @ts-expect-error on the offending property
const _i5: TaxEvent<'lp_fee'> = {
  type: 'lp_fee',
  // @ts-expect-error — 'gauge_claim' is not assignable to SubtypeOf<'lp_fee'>
  subtype: 'gauge_claim',
  chain: 'base',
  txHash: '0xabc',
  logIndex: 0,
  emissionSeq: 0,
  timestamp: 1_700_000_000,
  wallet: '0xwallet',
  handlerId: 'uniswap_v3',
  handlerVersion: 1,
};

export { _v1, _v2, _v3, _v4, _v5, _v6, _validSwap, _i1, _i2, _i3, _i4, _i5 };
