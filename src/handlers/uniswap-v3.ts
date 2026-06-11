import type { Chain, Protocol } from '../types/event';
import { UniV3LikeHandler } from './uni-v3-like-base';

/**
 * Uniswap V3 NonfungiblePositionManager on Base mainnet
 * (`.claude/docs/repo-analysis/v3-periphery.md`: NPM on Base is
 * 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1). Same bytecode as mainnet.
 */
export const UNISWAP_V3_NPM_BASE = '0x03a520b32c04bf3beef7beb72e919cf822ed34f1';

/**
 * Uniswap V3 protocol handler for Base ([1A.3], issue #7). All decoding logic
 * lives in `UniV3LikeHandler`; this subclass only pins the identity and the
 * NPM address. Aerodrome Slipstream ([1A.4]) extends the same base class with
 * its forked NPM address.
 */
export class UniswapV3Handler extends UniV3LikeHandler {
  readonly id = 'uniswap_v3';
  readonly version = 1;
  readonly chain: Chain = 'base';
  protected readonly protocol: Protocol = 'uniswap_v3';
  protected readonly positionManager = UNISWAP_V3_NPM_BASE;
}
