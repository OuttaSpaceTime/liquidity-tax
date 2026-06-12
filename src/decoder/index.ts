import { DecoderRegistry, type RegistryOptions } from './registry';
import type { Db } from '../db/client';
import { ALL_HANDLERS } from '../handlers';

export { DecoderRegistry, DuplicateEmissionError } from './registry';
export type { RegistryOptions } from './registry';
export type {
  AggregationHook,
  DecodeContext,
  DecodeResult,
  DecodedTx,
  GenericRule,
  Handler,
  RawTx,
} from './types';

export function createDefaultRegistry(db: Db, options?: RegistryOptions): DecoderRegistry {
  const registry = new DecoderRegistry(db, options);
  for (const handler of ALL_HANDLERS) registry.registerHandler(handler);
  // Phase-2 generic transfer rules (ERC-20/SPL/Sui coin movements) and
  // phase-3 aggregation hooks (multi-hop collapse, collect+increase linking)
  // register here as they land with the chain ingestors/handlers.
  return registry;
}
