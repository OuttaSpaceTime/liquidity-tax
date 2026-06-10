import type { Chain } from '../../types/event';
import type { Handler } from '../types';

/**
 * Placeholder handlers for every planned protocol. `matches()` always returns
 * false, so they never claim a tx; each is replaced by the real handler in its
 * phase-1A/1B/1C issue. Version 0 marks "not implemented".
 */
function stubHandler(id: string, chain: Chain): Handler {
  return {
    id,
    version: 0,
    chain,
    matches: () => false,
    decode: () => ({ kind: 'unclassified', reason: `${id} handler not implemented` }),
  };
}

// Base (EVM)
export const uniswapV3Stub = stubHandler('uniswap_v3', 'base');
export const aerodromeStub = stubHandler('aerodrome', 'base');
export const aaveV3Stub = stubHandler('aave_v3', 'base');

// Solana
export const orcaWhirlpoolStub = stubHandler('orca_whirlpool', 'solana');

// Sui
export const turbosStub = stubHandler('turbos', 'sui');
export const naviStub = stubHandler('navi', 'sui');
export const suilendStub = stubHandler('suilend', 'sui');
