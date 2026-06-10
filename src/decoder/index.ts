import { DecoderRegistry, type DecoderDb, type RegistryOptions } from './registry';
import {
  aaveV3Stub,
  aerodromeStub,
  naviStub,
  orcaWhirlpoolStub,
  suilendStub,
  turbosStub,
  uniswapV3Stub,
} from './handlers/stubs';

export { DecoderRegistry, DuplicateEmissionError } from './registry';
export type { DecoderDb, RegistryOptions } from './registry';
export type {
  AggregationHook,
  DecodeContext,
  DecodeResult,
  DecodedTx,
  GenericRule,
  Handler,
  RawTx,
} from './types';

/**
 * Explicit registration list (rotki: decoder module loading in
 * `_initialize_single_decoder`). Order matters within a chain — earlier
 * handlers see the tx first. Replace each stub with the real handler as its
 * issue lands.
 */
const HANDLERS = [
  // Base (EVM) — phase 1A
  uniswapV3Stub,
  aerodromeStub,
  aaveV3Stub,
  // Solana — phase 1B
  orcaWhirlpoolStub,
  // Sui — phase 1C
  turbosStub,
  naviStub,
  suilendStub,
] as const;

export function createDefaultRegistry(db: DecoderDb, options?: RegistryOptions): DecoderRegistry {
  const registry = new DecoderRegistry(db, options);
  for (const handler of HANDLERS) registry.registerHandler(handler);
  // Phase-2 generic transfer rules (ERC-20/SPL/Sui coin movements) and
  // phase-3 aggregation hooks (multi-hop collapse, collect+increase linking)
  // register here as they land with the chain ingestors/handlers.
  return registry;
}
