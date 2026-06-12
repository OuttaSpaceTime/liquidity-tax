import { describe, expect, test } from 'bun:test';
import { normalizeCoinType, suiCoinSymbol, SUI_COIN_REGISTRY } from '../../../src/chains/sui/coins';
import { coingeckoIdFor } from '../../../src/prices/token-map';

/**
 * Shared Sui coinType → symbol registry (quality-review consolidation).
 *
 * Regression focus: the navi/suilend/turbos handlers used to carry three
 * private symbol maps with CONFLICTING entries — the same Wormhole-SOL coin
 * type was 'WSOL' (navi) vs 'SOL' (suilend), native USDT was 'suiUSDT' (navi)
 * vs 'USDT' (suilend) — splitting FIFO lots and breaking the symbol→price
 * join in src/prices/token-map.ts. One registry, one symbol per coin type.
 */

const WORMHOLE_SOL = '0xb7844e289a8410e50fb3ca48d69eb9cf29e27d223ef90353fe1bd8e27ff8f3f8::coin::COIN';
const NATIVE_USDT = '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT';
const WORMHOLE_USDT = '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN';

describe('normalizeCoinType', () => {
  test('pads short-form addresses and strips 0x (registry/SDK constants vs parsedJson strings)', () => {
    expect(normalizeCoinType('0x2::sui::SUI')).toBe(
      '0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
    );
  });

  test('already-padded TypeName.name strings (no 0x) normalize to themselves', () => {
    const padded =
      'dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
    expect(normalizeCoinType(padded)).toBe(padded);
    expect(normalizeCoinType(`0x${padded}`)).toBe(padded);
  });
});

describe('suiCoinSymbol — one symbol per coin type across all handlers', () => {
  test('Wormhole SOL resolves to SOL (was WSOL in navi, SOL in suilend)', () => {
    expect(suiCoinSymbol(WORMHOLE_SOL)).toBe('SOL');
  });

  test('native and wormhole USDT both resolve to USDT (was suiUSDT vs USDT)', () => {
    expect(suiCoinSymbol(NATIVE_USDT)).toBe('USDT');
    expect(suiCoinSymbol(WORMHOLE_USDT)).toBe('USDT');
  });

  test('known coins resolve regardless of 0x prefix / padding', () => {
    expect(suiCoinSymbol('0x2::sui::SUI')).toBe('SUI');
    expect(
      suiCoinSymbol('0000000000000000000000000000000000000000000000000000000000000002::sui::SUI'),
    ).toBe('SUI');
  });

  test('LST symbols keep their registry casing (vSUI/haSUI, not CERT/HASUI)', () => {
    expect(
      suiCoinSymbol('0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT'),
    ).toBe('vSUI');
    expect(
      suiCoinSymbol(
        '0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI',
      ),
    ).toBe('haSUI');
  });

  test('single fallback rule: unknown coin → Move struct name', () => {
    expect(suiCoinSymbol('0xdead::mycoin::MYCOIN')).toBe('MYCOIN');
  });

  test('single fallback rule: unknown generic wormhole ::coin::COIN wrapper is unidentifiable', () => {
    expect(suiCoinSymbol('0xdead::coin::COIN')).toBeUndefined();
  });
});

describe('registry ↔ price-map alignment', () => {
  test('the previously-conflicting symbols are priceable via coingeckoIdFor()', () => {
    expect(coingeckoIdFor(suiCoinSymbol(WORMHOLE_SOL)!)).toBe('solana');
    expect(coingeckoIdFor(suiCoinSymbol(NATIVE_USDT)!)).toBe('tether');
    // 1:1 wrappers alias to the base asset (token-map convention).
    expect(coingeckoIdFor('wUSDC')).toBe('usd-coin');
    expect(coingeckoIdFor('WBTC')).toBe('bitcoin');
  });

  test('no two registry entries share a normalized coin type', () => {
    const keys = Object.keys(SUI_COIN_REGISTRY);
    expect(new Set(keys.map(normalizeCoinType)).size).toBe(keys.length);
  });
});
