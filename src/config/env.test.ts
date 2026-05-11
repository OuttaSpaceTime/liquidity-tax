import { describe, it, expect } from 'bun:test';
import { parseEnv, requireEnvKey } from './env';

describe('parseEnv', () => {
  it('returns DB_PATH default and undefined API keys when env is empty', () => {
    const result = parseEnv({});
    expect(result.DB_PATH).toBe('data/liquidity-tax.db');
    expect(result.HELIUS_API_KEY).toBeUndefined();
  });

  it('throws when SUI_RPC_URL is set but not a valid URL', () => {
    expect(() => parseEnv({ SUI_RPC_URL: 'not-a-url' })).toThrow(/SUI_RPC_URL/);
  });

  it('returns parsed values when env is populated', () => {
    const result = parseEnv({
      HELIUS_API_KEY: 'h',
      SUI_RPC_URL: 'https://sui.example/',
    });
    expect(result.HELIUS_API_KEY).toBe('h');
    expect(result.SUI_RPC_URL).toBe('https://sui.example/');
  });
});

describe('requireEnvKey', () => {
  it('throws naming the key when value is undefined', () => {
    const env = parseEnv({});
    expect(() => requireEnvKey(env, 'HELIUS_API_KEY')).toThrow(/HELIUS_API_KEY/);
  });

  it('returns the value when present', () => {
    const env = parseEnv({ HELIUS_API_KEY: 'test-key' });
    expect(requireEnvKey(env, 'HELIUS_API_KEY')).toBe('test-key');
  });
});
