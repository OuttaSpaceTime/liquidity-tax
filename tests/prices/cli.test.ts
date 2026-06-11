import { describe, it, expect } from 'bun:test';
import { pricesCommand, DEFAULT_EUR_CACHE_PATH } from '../../src/prices/cli';

describe('prices CLI command', () => {
  it('exposes backfill and import-eur-cache subcommands', () => {
    const cmd = pricesCommand();
    expect(cmd.name()).toBe('prices');
    expect(cmd.commands.map((c) => c.name()).sort()).toEqual(['backfill', 'import-eur-cache']);
  });

  it('backfill defaults --max-calls to 500', () => {
    const backfill = pricesCommand().commands.find((c) => c.name() === 'backfill')!;
    const opt = backfill.options.find((o) => o.long === '--max-calls')!;
    expect(opt.defaultValue).toBe('500');
  });

  it('import-eur-cache defaults to the liquidity-sheets cache path', () => {
    expect(DEFAULT_EUR_CACHE_PATH).toContain('liquidity-sheets');
    expect(DEFAULT_EUR_CACHE_PATH).toEndWith('eur_price_cache.json');
  });
});
