import { describe, expect, it } from 'bun:test';
import { redactSecrets } from '../../src/config/redact';

describe('redactSecrets', () => {
  it('replaces known secret values with ***', () => {
    const text = 'HTTP failed: https://base-mainnet.g.alchemy.com/v2/SECRETKEY123 body=...';
    expect(redactSecrets(text, ['SECRETKEY123'])).toBe(
      'HTTP failed: https://base-mainnet.g.alchemy.com/v2/*** body=...',
    );
  });

  it('redacts an Alchemy /v2/<key> URL segment even when the value is not in the list', () => {
    const text = 'URL: https://base-mainnet.g.alchemy.com/v2/LqqBs9akVISOVtnF9NoLm';
    expect(redactSecrets(text, [])).toBe('URL: https://base-mainnet.g.alchemy.com/v2/***');
  });

  it('redacts api-key=<token> query params (Helius/Sui style)', () => {
    const text = 'GET https://mainnet.helius-rpc.com/?api-key=abc-123_XYZ failed';
    expect(redactSecrets(text, [])).toBe('GET https://mainnet.helius-rpc.com/?api-key=*** failed');
  });

  it('ignores undefined secrets and leaves clean text unchanged', () => {
    const text = 'decode base: 625 txs → 151 decoded';
    expect(redactSecrets(text, [undefined, ''])).toBe(text);
  });
});
