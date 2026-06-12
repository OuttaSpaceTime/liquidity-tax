import type { Handler } from '../decoder/types';
import { UniswapV3Handler } from './uniswap-v3';
import { AerodromeHandler } from './aerodrome';
import { AaveV3Handler } from './aave-v3';
import { MorphoHandler } from './morpho';
import { orcaWhirlpoolHandler } from './orca-whirlpool';
import { turbosHandler } from './turbos';
import { naviHandler } from './navi';
import { suilendHandler } from './suilend';

/**
 * Explicit registration list of all real protocol handlers (rotki: decoder
 * module loading in `_initialize_single_decoder`). Order matters within a
 * chain — earlier handlers see the tx first.
 *
 * Convention: new handlers are plain object literals (orca/turbos/navi/
 * suilend style). Classes only where shared behavior is the point
 * (UniV3LikeHandler and its subclasses); AaveV3Handler/MorphoHandler predate
 * this note.
 */
export const ALL_HANDLERS: readonly Handler[] = [
  // Base (EVM) — phase 1A
  new UniswapV3Handler(),
  new AerodromeHandler(),
  new AaveV3Handler(),
  new MorphoHandler(),
  // Solana — phase 1B
  orcaWhirlpoolHandler,
  // Sui — phase 1C. Turbos runs LAST: aggregator-routed PTBs (7k settle::Swap,
  // FlowX universal_router::Swap) often route one hop through a Turbos pool;
  // the dominant protocol (navi/suilend) claims the collapsed swap total first
  // and turbos defers to already-claimed log indexes (suilend-03 fixture).
  naviHandler,
  suilendHandler,
  turbosHandler,
];
