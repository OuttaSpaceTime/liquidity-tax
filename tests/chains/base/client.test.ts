import { describe, it, expect } from 'bun:test';
import { env } from '../../../src/config/env';
import {
  alchemyBaseUrl,
  createBaseClient,
  createPublicBaseClient,
  PUBLIC_BASE_RPC_URL,
} from '../../../src/chains/base/client';

// Presence flag only — the key value itself is never read or printed here.
const hasAlchemyKey = env.ALCHEMY_API_KEY !== undefined;

describe('base viem clients', () => {
  it('public fallback client targets the keyless Tenderly gateway on Base mainnet', () => {
    expect(PUBLIC_BASE_RPC_URL).toBe('https://gateway.tenderly.co/public/base');
    const client = createPublicBaseClient();
    expect(client.chain.id).toBe(8453);
    expect(client.transport.url).toBe(PUBLIC_BASE_RPC_URL);
    // Ingest owns 429 backoff — viem's transport retry must stay off.
    expect(client.transport.retryCount).toBe(0);
    expect(client.transport.timeout).toBe(60_000);
  });

  it.skipIf(!hasAlchemyKey)('alchemy client builds the Base-mainnet URL from the env key', () => {
    // Boolean assertions only: a failure message must never echo the URL/key.
    expect(alchemyBaseUrl().startsWith('https://base-mainnet.g.alchemy.com/v2/')).toBe(true);
    expect(alchemyBaseUrl().length).toBeGreaterThan('https://base-mainnet.g.alchemy.com/v2/'.length);
    const client = createBaseClient();
    expect(client.chain.id).toBe(8453);
    expect(client.transport.retryCount).toBe(0);
    expect(client.transport.timeout).toBe(30_000);
  });

  it.skipIf(hasAlchemyKey)('alchemyBaseUrl throws when ALCHEMY_API_KEY is not configured', () => {
    expect(() => alchemyBaseUrl()).toThrow('Missing required env var: ALCHEMY_API_KEY');
  });
});
