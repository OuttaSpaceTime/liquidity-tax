import { describe, expect, test } from 'bun:test';
import {
  LINK_WINDOW_SECONDS,
  matchTransfers,
  type TransferLeg,
} from '../../src/linker/match';

const T0 = 1_750_000_000; // arbitrary epoch seconds

let nextId = 1;
function leg(
  overrides: Partial<TransferLeg> & Pick<TransferLeg, 'chain' | 'asset' | 'amount'>,
): TransferLeg {
  const id = nextId++;
  return {
    eventId: id,
    wallet: 'walletA',
    txHash: `tx-${id}`,
    timestamp: T0,
    ...overrides,
  };
}

// Wormhole WETH mint on Solana (8 decimals) — known to the linker asset registry.
const WH_WETH_MINT = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

describe('matchTransfers — cross-chain bridge heuristic', () => {
  test('clean match: fee-shaved WETH base→solana within window → confirmed bridge link', () => {
    const out = leg({ chain: 'base', asset: 'WETH', amount: 10n ** 18n }); // 1.0 ETH
    const inn = leg({
      chain: 'solana',
      asset: WH_WETH_MINT,
      amount: 99_700_000n, // 0.997 ETH after bridge fee (8 decimals)
      timestamp: T0 + 300,
      wallet: 'phantom-wallet',
    });
    const matches = matchTransfers([out], [inn]);
    expect(matches).toHaveLength(1);
    const m = matches[0]!;
    expect(m.outEventId).toBe(out.eventId);
    expect(m.inEventId).toBe(inn.eventId);
    expect(m.kind).toBe('bridge');
    expect(m.status).toBe('confirmed');
    expect(m.heuristic).toBe('cross_chain_same_asset_30min');
    expect(m.confidence).toBeGreaterThan(0.9);
    expect(m.confidence).toBeLessThan(1);
  });

  test('amount shaved beyond 10% → no match', () => {
    const out = leg({ chain: 'base', asset: 'WETH', amount: 10n ** 18n });
    const inn = leg({
      chain: 'solana',
      asset: WH_WETH_MINT,
      amount: 85_000_000n, // 0.85 ETH — too much slippage for a bridge fee
      timestamp: T0 + 300,
    });
    expect(matchTransfers([out], [inn])).toHaveLength(0);
  });

  test('outside ±30 min window → no match', () => {
    const out = leg({ chain: 'base', asset: 'WETH', amount: 10n ** 18n });
    const inn = leg({
      chain: 'solana',
      asset: WH_WETH_MINT,
      amount: 99_700_000n,
      timestamp: T0 + LINK_WINDOW_SECONDS + 200,
    });
    expect(matchTransfers([out], [inn])).toHaveLength(0);
  });

  test('canonical-asset mismatch (USDC out vs SOL in) → no match', () => {
    const out = leg({ chain: 'base', asset: 'USDC', amount: 1_000_000_000n });
    const inn = leg({
      chain: 'solana',
      asset: SOL_MINT,
      amount: 1_000_000_000n,
      timestamp: T0 + 60,
    });
    expect(matchTransfers([out], [inn])).toHaveLength(0);
  });

  test('unknown asset cannot be normalized cross-chain → no match', () => {
    const out = leg({ chain: 'base', asset: 'FOO', amount: 1_000_000n });
    const inn = leg({ chain: 'sui', asset: 'FOO', amount: 1_000_000n, timestamp: T0 + 60 });
    expect(matchTransfers([out], [inn])).toHaveLength(0);
  });

  test('two viable candidates → best linked, status pending', () => {
    const out = leg({ chain: 'base', asset: 'USDC', amount: 1_000_000_000n }); // 1000 USDC
    const best = leg({
      chain: 'solana',
      asset: USDC_MINT,
      amount: 997_000_000n,
      timestamp: T0 + 120,
    });
    const worse = leg({
      chain: 'solana',
      asset: USDC_MINT,
      amount: 960_000_000n,
      timestamp: T0 + 900,
    });
    const matches = matchTransfers([out], [best, worse]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.inEventId).toBe(best.eventId);
    expect(matches[0]!.status).toBe('pending');
  });
});

describe('matchTransfers — same-chain self-transfer heuristic (issue #11)', () => {
  test('exact amount between two own wallets → confidence 1.0, confirmed', () => {
    const out = leg({ chain: 'base', asset: 'USDC', amount: 500_000_000n, wallet: 'walletA' });
    const inn = leg({
      chain: 'base',
      asset: 'USDC',
      amount: 500_000_000n,
      wallet: 'walletB',
      timestamp: T0 + 30,
    });
    const matches = matchTransfers([out], [inn]);
    expect(matches).toHaveLength(1);
    const m = matches[0]!;
    expect(m.kind).toBe('self_transfer');
    expect(m.status).toBe('confirmed');
    expect(m.confidence).toBe(1.0);
    expect(m.heuristic).toBe('same_asset_30min_own_wallet');
  });

  test('amount within ±0.5% but not exact → confidence 0.8', () => {
    const out = leg({ chain: 'base', asset: 'USDC', amount: 1_000_000_000n, wallet: 'walletA' });
    const inn = leg({
      chain: 'base',
      asset: 'USDC',
      amount: 997_000_000n, // -0.3%
      wallet: 'walletB',
      timestamp: T0 + 30,
    });
    const matches = matchTransfers([out], [inn]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.confidence).toBe(0.8);
  });

  test('amount off by 1% → no same-chain match (and never falls through to bridge)', () => {
    const out = leg({ chain: 'base', asset: 'USDC', amount: 1_000_000_000n, wallet: 'walletA' });
    const inn = leg({
      chain: 'base',
      asset: 'USDC',
      amount: 990_000_000n,
      wallet: 'walletB',
      timestamp: T0 + 30,
    });
    expect(matchTransfers([out], [inn])).toHaveLength(0);
  });

  test('same wallet on both sides → no self-transfer link', () => {
    const out = leg({ chain: 'base', asset: 'USDC', amount: 500_000_000n, wallet: 'walletA' });
    const inn = leg({
      chain: 'base',
      asset: 'USDC',
      amount: 500_000_000n,
      wallet: 'walletA',
      timestamp: T0 + 30,
    });
    expect(matchTransfers([out], [inn])).toHaveLength(0);
  });

  test('two candidate receivers → linked once, status pending', () => {
    const out = leg({ chain: 'base', asset: 'USDC', amount: 500_000_000n, wallet: 'walletA' });
    const exact = leg({
      chain: 'base',
      asset: 'USDC',
      amount: 500_000_000n,
      wallet: 'walletB',
      timestamp: T0 + 30,
    });
    const shaved = leg({
      chain: 'base',
      asset: 'USDC',
      amount: 499_000_000n,
      wallet: 'walletC',
      timestamp: T0 + 30,
    });
    const matches = matchTransfers([out], [exact, shaved]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.inEventId).toBe(exact.eventId);
    expect(matches[0]!.status).toBe('pending');
  });
});

describe('matchTransfers — combined', () => {
  test('one self-transfer pair + one bridge pair in one pass, no double-consumption', () => {
    const selfOut = leg({ chain: 'base', asset: 'USDC', amount: 100_000_000n, wallet: 'walletA' });
    const selfIn = leg({
      chain: 'base',
      asset: 'USDC',
      amount: 100_000_000n,
      wallet: 'walletB',
      timestamp: T0 + 10,
    });
    const bridgeOut = leg({ chain: 'base', asset: 'WETH', amount: 2n * 10n ** 18n });
    const bridgeIn = leg({
      chain: 'solana',
      asset: WH_WETH_MINT,
      amount: 199_400_000n,
      timestamp: T0 + 600,
      wallet: 'phantom-wallet',
    });
    const matches = matchTransfers([selfOut, bridgeOut], [selfIn, bridgeIn]);
    expect(matches).toHaveLength(2);
    const kinds = matches.map((m) => m.kind).sort();
    expect(kinds).toEqual(['bridge', 'self_transfer']);
    for (const m of matches) expect(m.status).toBe('confirmed');
  });
});
