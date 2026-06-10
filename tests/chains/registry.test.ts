import { describe, it, expect } from 'bun:test';
import { ChainRegistry, createDefaultChainRegistry } from '../../src/chains/registry';
import type { IngestAdapter } from '../../src/chains/registry';

function makeAdapter(chain: IngestAdapter['chain']): IngestAdapter {
  return {
    chain,
    ingest: async () => ({ fetched: 0, upserted: 0 }),
  };
}

describe('chain registry', () => {
  it('registers and resolves an adapter by chain', () => {
    const registry = new ChainRegistry();
    const adapter = makeAdapter('base');
    registry.register(adapter);
    expect(registry.get('base')).toBe(adapter);
    expect(registry.chains()).toEqual(['base']);
  });

  it('returns undefined for a chain without an adapter', () => {
    const registry = new ChainRegistry();
    expect(registry.get('sui')).toBeUndefined();
  });

  it('rejects duplicate registration for the same chain', () => {
    const registry = new ChainRegistry();
    registry.register(makeAdapter('solana'));
    expect(() => registry.register(makeAdapter('solana'))).toThrow(/solana/);
  });

  it('createDefaultChainRegistry returns a registry (adapters land with chain issues)', () => {
    const registry = createDefaultChainRegistry();
    expect(registry).toBeInstanceOf(ChainRegistry);
  });
});
