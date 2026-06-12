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
    // 'navi-protocol' / 'carrot' do NOT exist on CoinGecko (404 not_found in the
    // 2026-06-11 backfill run) — real ids verified via /search + /coins/{id}
    // platform addresses: NAVX → 'navi', CRT (Solana Carrot) → 'carrot-2'.
    expect(coingeckoIdFor('NAVX')).toBe('navi');
    expect(coingeckoIdFor('JLP')).toBe('jupiter-perpetuals-liquidity-provider-token');
    expect(coingeckoIdFor('WAL')).toBe('walrus-2');
    expect(coingeckoIdFor('SCA')).toBe('scallop');
    expect(coingeckoIdFor('CRT')).toBe('carrot-2');
  });

  it('maps raw on-chain asset ids (mints / ERC-20 addresses / Sui coin types) emitted by handlers', () => {
    // Solana mints (verified via CoinGecko /coins/{id} platform addresses + DefiLlama symbols)
    expect(coingeckoIdFor('So11111111111111111111111111111111111111112')).toBe('solana');
    expect(coingeckoIdFor('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe('usd-coin');
    expect(coingeckoIdFor('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn')).toBe('jito-staked-sol');
    expect(coingeckoIdFor('orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE')).toBe('orca');
    expect(coingeckoIdFor('pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn')).toBe('pump-fun');
    expect(coingeckoIdFor('CRTx1JouZhzSU6XytsE42UQraoGqiHgxabocVfARTy2s')).toBe('carrot-2');
    expect(coingeckoIdFor('HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC')).toBe('ai16z');
    expect(coingeckoIdFor('27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4')).toBe(
      'jupiter-perpetuals-liquidity-provider-token',
    );
    expect(coingeckoIdFor('3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC')).toBe('solstice-eusx');
    expect(coingeckoIdFor('6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG')).toBe('usx');
    // Base ERC-20 addresses
    expect(coingeckoIdFor('0x50c5725949a6f0c72e6c4a641f24049a917db0cb')).toBe('dai');
    expect(coingeckoIdFor('0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42')).toBe('euro-coin');
    expect(coingeckoIdFor('0x35e5db674d8e93a03d814fa0ada70731efe8a4b9')).toBe('resolv-usr');
    // Sui coin types
    expect(
      coingeckoIdFor(
        '0x3a304c7feba2d819ea57c3542d68439ca2c386ba02159c740f7b406e592c62ea::haedal::HAEDAL',
      ),
    ).toBe('haedal');
    expect(
      coingeckoIdFor(
        '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA',
      ),
    ).toBe('ika');
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
    expect(assetsForCoingeckoId('bitcoin')).toEqual(['BTC', 'WBTC', 'cbBTC']);
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
