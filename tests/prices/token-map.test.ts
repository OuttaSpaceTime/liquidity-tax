import { describe, it, expect } from 'bun:test';
import {
  TOKEN_TO_COINGECKO_ID,
  coingeckoIdFor,
  assetsForCoingeckoId,
} from '../../src/prices/token-map';

describe('token map', () => {
  it('seeds the production map from liquidity-sheets price_in_eur.py', () => {
    // Spot-check the ids that the sheets pipeline already used in production.
    expect(coingeckoIdFor('SOL')).toBe('solana');
    expect(coingeckoIdFor('ETH')).toBe('ethereum');
    expect(coingeckoIdFor('SUI')).toBe('sui');
    expect(coingeckoIdFor('USDC')).toBe('usd-coin');
    expect(coingeckoIdFor('USDT')).toBe('tether');
    expect(coingeckoIdFor('AERO')).toBe('aerodrome-finance');
    expect(coingeckoIdFor('ORCA')).toBe('orca');
    expect(coingeckoIdFor('CETUS')).toBe('cetus-protocol');
    expect(coingeckoIdFor('NAVX')).toBe('navi-protocol');
    expect(coingeckoIdFor('JLP')).toBe('jupiter-perpetuals-liquidity-provider-token');
    expect(coingeckoIdFor('WAL')).toBe('walrus-2');
    expect(coingeckoIdFor('SCA')).toBe('scallop');
    expect(coingeckoIdFor('CRT')).toBe('carrot');
  });

  it('aliases 1:1 wrappers to their base asset (py decision, exact 1:1 redeemability)', () => {
    expect(coingeckoIdFor('WETH')).toBe('ethereum');
    expect(coingeckoIdFor('cbBTC')).toBe('bitcoin');
  });

  it('prices liquid-staking tokens at their own native CoinGecko ids (not 1:1)', () => {
    expect(coingeckoIdFor('VSUI')).toBe('volo-staked-sui');
    expect(coingeckoIdFor('SSUI')).toBe('spring-staked-sui');
    expect(coingeckoIdFor('AFSUI')).toBe('aftermath-staked-sui');
    expect(coingeckoIdFor('STSUI')).toBe('alphafi-stsui');
    expect(coingeckoIdFor('HASUI')).toBe('haedal-staked-sui');
    expect(coingeckoIdFor('JITOSOL')).toBe('jito-staked-sol');
  });

  it('covers the issue-12 Base assets', () => {
    expect(coingeckoIdFor('cbETH')).toBe('coinbase-wrapped-staked-eth');
    expect(coingeckoIdFor('AAVE')).toBe('aave');
  });

  it('is case-insensitive and returns undefined for unknown assets', () => {
    expect(coingeckoIdFor('eth')).toBe('ethereum');
    expect(coingeckoIdFor('CbBtC')).toBe('bitcoin');
    expect(coingeckoIdFor('NOT-A-TOKEN')).toBeUndefined();
  });

  it('reverse-maps a CoinGecko id to all asset symbols priced by it, sorted', () => {
    expect(assetsForCoingeckoId('ethereum')).toEqual(['ETH', 'WETH']);
    expect(assetsForCoingeckoId('bitcoin')).toEqual(['BTC', 'cbBTC']);
    expect(assetsForCoingeckoId('sui')).toEqual(['SUI']);
    expect(assetsForCoingeckoId('weth')).toEqual([]); // stale CC feed id — deliberately unmapped
  });

  it('has no empty or whitespace ids', () => {
    for (const [asset, id] of Object.entries(TOKEN_TO_COINGECKO_ID)) {
      expect(asset.trim()).toBe(asset);
      expect(id).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
