import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { events, transferLinks } from '../../db/schema';
import { runLinker } from '../../src/linker/run';
import { listLinksForAssetWallet } from '../../src/linker/repo';
import { createTestDb, type TestDb } from '../helpers/db';
import type { Chain } from '../../src/types/event';

const T0 = 1_750_000_000;
const WH_WETH_MINT = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';

interface SeedOpts {
  chain: Chain;
  wallet: string;
  subtype: 'send' | 'receive';
  asset: string;
  amount: bigint;
  timestamp: number;
  txHash: string;
  logIndex?: number;
}

function seedTransfer(t: TestDb, opts: SeedOpts): number {
  const row = t.db
    .insert(events)
    .values({
      chain: opts.chain,
      txHash: opts.txHash,
      logIndex: opts.logIndex ?? 0,
      emissionSeq: 0,
      timestamp: opts.timestamp,
      wallet: opts.wallet,
      type: 'transfer',
      subtype: opts.subtype,
      sentAsset: opts.subtype === 'send' ? opts.asset : null,
      sentAmount: opts.subtype === 'send' ? opts.amount : null,
      receivedAsset: opts.subtype === 'receive' ? opts.asset : null,
      receivedAmount: opts.subtype === 'receive' ? opts.amount : null,
      handlerId: 'test-seed',
      handlerVersion: 1,
    })
    .returning({ id: events.id })
    .get();
  return row.id;
}

function eventById(t: TestDb, id: number) {
  return t.db.select().from(events).where(eq(events.id, id)).get()!;
}

describe('runLinker', () => {
  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });

  test('cross-chain bridge pair → confirmed link + bridge_out/bridge_in flags, subtypes preserved', () => {
    const outId = seedTransfer(t, {
      chain: 'base',
      wallet: 'walletA',
      subtype: 'send',
      asset: 'WETH',
      amount: 10n ** 18n,
      timestamp: T0,
      txHash: 'base-tx-1',
    });
    const inId = seedTransfer(t, {
      chain: 'solana',
      wallet: 'walletSol',
      subtype: 'receive',
      asset: WH_WETH_MINT,
      amount: 99_700_000n,
      timestamp: T0 + 300,
      txHash: 'sol-tx-1',
    });

    const summary = runLinker(t.db);
    expect(summary.written).toBe(1);

    const links = t.db.select().from(transferLinks).all();
    expect(links).toHaveLength(1);
    expect(links[0]!.outEventId).toBe(outId);
    expect(links[0]!.inEventId).toBe(inId);
    expect(links[0]!.status).toBe('confirmed');
    expect(links[0]!.heuristic).toBe('cross_chain_same_asset_30min');

    const outEvent = eventById(t, outId);
    const inEvent = eventById(t, inId);
    expect(outEvent.subtype).toBe('send'); // non-destructive
    expect(inEvent.subtype).toBe('receive');
    expect(outEvent.flagsJson).toContain('bridge_out');
    expect(inEvent.flagsJson).toContain('bridge_in');
  });

  test('same-chain self-transfer pair → link + subtype retag + self_transfer flag (issue #11)', () => {
    const outId = seedTransfer(t, {
      chain: 'base',
      wallet: 'walletA',
      subtype: 'send',
      asset: 'USDC',
      amount: 500_000_000n,
      timestamp: T0,
      txHash: 'base-tx-2',
      logIndex: 1,
    });
    const inId = seedTransfer(t, {
      chain: 'base',
      wallet: 'walletB',
      subtype: 'receive',
      asset: 'USDC',
      amount: 500_000_000n,
      timestamp: T0,
      txHash: 'base-tx-2',
      logIndex: 2,
    });

    const summary = runLinker(t.db);
    expect(summary.written).toBe(1);

    const link = t.db.select().from(transferLinks).get()!;
    expect(link.outEventId).toBe(outId);
    expect(link.inEventId).toBe(inId);
    expect(link.confidence).toBe(1.0);
    expect(link.status).toBe('confirmed');
    expect(link.heuristic).toBe('same_asset_30min_own_wallet');

    for (const id of [outId, inId]) {
      const row = eventById(t, id);
      expect(row.subtype).toBe('self_transfer');
      expect(row.flagsJson).toContain('self_transfer');
    }
  });

  test('rerun is idempotent: no duplicate links, no duplicate flags', () => {
    seedTransfer(t, {
      chain: 'base',
      wallet: 'walletA',
      subtype: 'send',
      asset: 'USDC',
      amount: 500_000_000n,
      timestamp: T0,
      txHash: 'base-tx-3',
      logIndex: 1,
    });
    const inId = seedTransfer(t, {
      chain: 'base',
      wallet: 'walletB',
      subtype: 'receive',
      asset: 'USDC',
      amount: 500_000_000n,
      timestamp: T0 + 5,
      txHash: 'base-tx-4',
    });

    expect(runLinker(t.db).written).toBe(1);
    const second = runLinker(t.db);
    expect(second.written).toBe(0);

    expect(t.db.select().from(transferLinks).all()).toHaveLength(1);
    const flags = eventById(t, inId).flagsJson;
    expect(flags).toEqual(['self_transfer']);
  });

  test('events already in a link (any status, incl. rejected) are never re-linked', () => {
    const outId = seedTransfer(t, {
      chain: 'base',
      wallet: 'walletA',
      subtype: 'send',
      asset: 'USDC',
      amount: 500_000_000n,
      timestamp: T0,
      txHash: 'base-tx-5',
    });
    const inId = seedTransfer(t, {
      chain: 'base',
      wallet: 'walletB',
      subtype: 'receive',
      asset: 'USDC',
      amount: 500_000_000n,
      timestamp: T0 + 5,
      txHash: 'base-tx-6',
    });
    t.db
      .insert(transferLinks)
      .values({
        outEventId: outId,
        inEventId: inId,
        confidence: 0.8,
        status: 'rejected',
        heuristic: 'same_asset_30min_own_wallet',
      })
      .run();

    const summary = runLinker(t.db);
    expect(summary.written).toBe(0);
    expect(t.db.select().from(transferLinks).all()).toHaveLength(1);
    expect(eventById(t, outId).subtype).toBe('send'); // untouched
  });

  test('unmatched external send stays transfer:send with no flags', () => {
    const id = seedTransfer(t, {
      chain: 'base',
      wallet: 'walletA',
      subtype: 'send',
      asset: 'AERO',
      amount: 123n,
      timestamp: T0,
      txHash: 'base-tx-7',
    });
    const summary = runLinker(t.db);
    expect(summary.written).toBe(0);
    const row = eventById(t, id);
    expect(row.subtype).toBe('send');
    expect(row.flagsJson).toBeNull();
  });

  test('dry run reports matches but writes nothing', () => {
    seedTransfer(t, {
      chain: 'base',
      wallet: 'walletA',
      subtype: 'send',
      asset: 'USDC',
      amount: 500_000_000n,
      timestamp: T0,
      txHash: 'base-tx-8',
    });
    seedTransfer(t, {
      chain: 'base',
      wallet: 'walletB',
      subtype: 'receive',
      asset: 'USDC',
      amount: 500_000_000n,
      timestamp: T0 + 5,
      txHash: 'base-tx-9',
    });

    const summary = runLinker(t.db, { dryRun: true });
    expect(summary.matches).toHaveLength(1);
    expect(summary.written).toBe(0);
    expect(t.db.select().from(transferLinks).all()).toHaveLength(0);
  });

  test('tax-engine query shape: links queryable per (asset, wallet)', () => {
    seedTransfer(t, {
      chain: 'base',
      wallet: 'walletA',
      subtype: 'send',
      asset: 'USDC',
      amount: 500_000_000n,
      timestamp: T0,
      txHash: 'base-tx-10',
    });
    seedTransfer(t, {
      chain: 'base',
      wallet: 'walletB',
      subtype: 'receive',
      asset: 'USDC',
      amount: 500_000_000n,
      timestamp: T0 + 5,
      txHash: 'base-tx-11',
    });
    runLinker(t.db);

    // Receiving wallet's perspective: lot arrives into the (USDC, walletB) pool.
    const forB = listLinksForAssetWallet(t.db, { asset: 'USDC', wallet: 'walletB' });
    expect(forB).toHaveLength(1);
    expect(forB[0]!.outEvent.wallet).toBe('walletA');
    expect(forB[0]!.inEvent.wallet).toBe('walletB');
    expect(forB[0]!.link.status).toBe('confirmed');

    // Sending wallet's perspective: lot leaves the (USDC, walletA) pool.
    expect(listLinksForAssetWallet(t.db, { asset: 'USDC', wallet: 'walletA' })).toHaveLength(1);
    // Uninvolved wallet: nothing.
    expect(listLinksForAssetWallet(t.db, { asset: 'USDC', wallet: 'walletX' })).toHaveLength(0);
  });
});
