import { describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { events, rawTxs } from '../../../db/schema';
import { createDefaultChainRegistry } from '../../../src/chains/registry';
import {
  createSuiIngestAdapter,
  type SuiAddressFilter,
  type SuiRpcLike,
  type SuiTxBlockPage,
  type SuiTxBlockSummary,
} from '../../../src/chains/sui/ingest';
import type { Wallet } from '../../../src/config/wallets-loader';
import { createTestDb } from '../../helpers/db';

// Synthetic infra tests (pagination, two-pass dedupe, rate limiting,
// idempotency) — protocol handlers use real fixtures per the test-first rule;
// ingest plumbing does not. Mirrors tests/chains/solana/ingest.test.ts.
const OWN = '0x' + 'a1'.repeat(32);
const FOREIGN = '0x' + 'f0'.repeat(32);

const wallet: Wallet = { chain: 'sui', address: OWN, label: 'phantom-sui-test', status: 'active' };

function summary(digest: string, timestampMs: number | null): SuiTxBlockSummary {
  return { digest, timestampMs: timestampMs === null ? null : String(timestampMs) };
}

/** Minimal SuiTransactionBlockResponse-shaped getTransactionBlock payload. */
function txResponse(
  digest: string,
  opts: {
    checkpoint: number;
    timestampMs: number;
    sender?: string;
    computationCost?: string;
    storageCost?: string;
    storageRebate?: string;
  },
): unknown {
  return {
    digest,
    checkpoint: String(opts.checkpoint),
    timestampMs: String(opts.timestampMs),
    transaction: { data: { sender: opts.sender ?? OWN } },
    effects: {
      status: { status: 'success' },
      gasUsed: {
        computationCost: opts.computationCost ?? '750000',
        storageCost: opts.storageCost ?? '2964000',
        storageRebate: opts.storageRebate ?? '2433564',
        nonRefundableStorageFee: '24582',
      },
    },
    events: [],
    balanceChanges: [],
  };
}

function filterKey(filter: SuiAddressFilter): string {
  return 'FromAddress' in filter ? `from:${filter.FromAddress}` : `to:${filter.ToAddress}`;
}

class FakeSuiRpc implements SuiRpcLike {
  /** Page queues per filter (from:<addr> / to:<addr>). */
  pages = new Map<string, SuiTxBlockPage[]>();
  queryCalls: Array<{ filter: string; cursor: string | null | undefined }> = [];
  /** Per-digest queue of responses; an Error entry rejects that attempt. */
  txResponses = new Map<string, Array<unknown>>();
  txCalls: string[] = [];

  setPages(filter: SuiAddressFilter, ...pages: SuiTxBlockPage[]): void {
    this.pages.set(filterKey(filter), pages);
  }

  respond(digest: string, ...responses: Array<unknown>): void {
    this.txResponses.set(digest, responses);
  }

  async queryTransactionBlocks(params: {
    filter: SuiAddressFilter;
    cursor?: string | null;
    limit?: number;
  }): Promise<SuiTxBlockPage> {
    const key = filterKey(params.filter);
    this.queryCalls.push({ filter: key, cursor: params.cursor });
    const queue = this.pages.get(key);
    return queue?.shift() ?? { data: [], hasNextPage: false, nextCursor: null };
  }

  async getTransactionBlock(params: { digest: string }): Promise<unknown> {
    this.txCalls.push(params.digest);
    const queue = this.txResponses.get(params.digest);
    if (queue === undefined || queue.length === 0) {
      throw new Error(`FakeSuiRpc: no scripted response for ${params.digest}`);
    }
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  }
}

function makeAdapter(rpc: FakeSuiRpc, overrides: Record<string, unknown> = {}) {
  return createSuiIngestAdapter({
    rpc,
    pageSize: 2,
    minRequestIntervalMs: 0,
    maxRetries: 0,
    sleep: async () => {},
    log: () => {},
    ...overrides,
  });
}

describe('sui ingest adapter', () => {
  it('paginates FromAddress with a cursor, then ToAddress, deduping digests', async () => {
    const { db } = createTestDb();
    const rpc = new FakeSuiRpc();
    // FromAddress pass: 2 pages (cursor-driven).
    rpc.setPages(
      { FromAddress: OWN },
      { data: [summary('dgA', 1_700_000_300_000), summary('dgB', 1_700_000_200_000)], hasNextPage: true, nextCursor: 'dgB' },
      { data: [summary('dgC', 1_700_000_100_000)], hasNextPage: false, nextCursor: null },
    );
    // ToAddress pass: overlaps dgB (self-send), adds dgD (incoming-only tx).
    rpc.setPages(
      { ToAddress: OWN },
      { data: [summary('dgB', 1_700_000_200_000), summary('dgD', 1_700_000_050_000)], hasNextPage: false, nextCursor: null },
    );
    for (const [digest, ts] of [
      ['dgA', 1_700_000_300],
      ['dgB', 1_700_000_200],
      ['dgC', 1_700_000_100],
      ['dgD', 1_700_000_050],
    ] as const) {
      rpc.respond(digest, txResponse(digest, { checkpoint: 90_000_000, timestampMs: ts * 1000 }));
    }

    const result = await makeAdapter(rpc).ingest([wallet], { db });

    expect(result).toEqual({ fetched: 4, upserted: 4 });
    expect(rpc.queryCalls).toEqual([
      { filter: `from:${OWN}`, cursor: undefined },
      { filter: `from:${OWN}`, cursor: 'dgB' },
      { filter: `to:${OWN}`, cursor: undefined },
    ]);
    // dgB fetched exactly once despite appearing in both passes.
    expect(rpc.txCalls.sort()).toEqual(['dgA', 'dgB', 'dgC', 'dgD']);
    const rows = db.select().from(rawTxs).all();
    expect(rows.map((r) => r.txHash).sort()).toEqual(['dgA', 'dgB', 'dgC', 'dgD']);
    const dgA = rows.find((r) => r.txHash === 'dgA');
    expect(dgA?.chain).toBe('sui');
    expect(dgA?.blockNumber).toBe(90_000_000);
    expect(dgA?.blockTimestamp).toBe(1_700_000_300);
  });

  it('is idempotent — rerun fetches only digests missing from raw_txs', async () => {
    const { db } = createTestDb();
    db.insert(rawTxs)
      .values({
        chain: 'sui',
        txHash: 'dgB',
        blockNumber: 90_000_000,
        blockTimestamp: 1_700_000_200,
        rawJson: { already: 'stored' },
        fetchedAt: 1_700_000_900,
      })
      .run();

    const rpc = new FakeSuiRpc();
    rpc.setPages(
      { FromAddress: OWN },
      {
        data: [summary('dgA', 1_700_000_300_000), summary('dgB', 1_700_000_200_000)],
        hasNextPage: false,
        nextCursor: null,
      },
    );
    rpc.respond('dgA', txResponse('dgA', { checkpoint: 90_000_001, timestampMs: 1_700_000_300_000 }));

    const result = await makeAdapter(rpc).ingest([wallet], { db });

    expect(result).toEqual({ fetched: 2, upserted: 1 });
    expect(rpc.txCalls).toEqual(['dgA']); // dgB skipped
    expect(db.select().from(rawTxs).all()).toHaveLength(2);
  });

  it('retries with exponential backoff on 429 responses', async () => {
    const { db } = createTestDb();
    const rpc = new FakeSuiRpc();
    rpc.setPages(
      { FromAddress: OWN },
      { data: [summary('dgA', 1_700_000_100_000)], hasNextPage: false, nextCursor: null },
    );
    rpc.respond(
      'dgA',
      new Error('429 Too Many Requests'),
      new Error('429 Too Many Requests'),
      txResponse('dgA', { checkpoint: 90_000_000, timestampMs: 1_700_000_100_000 }),
    );
    const sleeps: number[] = [];
    const adapter = makeAdapter(rpc, {
      maxRetries: 3,
      retryBaseMs: 100,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    const result = await adapter.ingest([wallet], { db });

    expect(result.upserted).toBe(1);
    expect(rpc.txCalls).toEqual(['dgA', 'dgA', 'dgA']);
    expect(sleeps).toEqual([100, 200]); // exponential backoff
  });

  it('does not retry non-retryable errors and flushes prior progress (resumable)', async () => {
    const { db } = createTestDb();
    const rpc = new FakeSuiRpc();
    rpc.setPages(
      { FromAddress: OWN },
      {
        data: [summary('dgA', 1_700_000_300_000), summary('dgB', 1_700_000_200_000)],
        hasNextPage: false,
        nextCursor: null,
      },
    );
    rpc.respond('dgA', txResponse('dgA', { checkpoint: 90_000_000, timestampMs: 1_700_000_300_000 }));
    rpc.respond('dgB', new Error('Invalid params'));

    await expect(makeAdapter(rpc, { flushEvery: 1 }).ingest([wallet], { db })).rejects.toThrow(
      'Invalid params',
    );
    // dgA was flushed before the failure — a rerun resumes from there.
    expect(db.select().from(rawTxs).all().map((r) => r.txHash)).toEqual(['dgA']);

    const rpc2 = new FakeSuiRpc();
    rpc2.setPages(
      { FromAddress: OWN },
      {
        data: [summary('dgA', 1_700_000_300_000), summary('dgB', 1_700_000_200_000)],
        hasNextPage: false,
        nextCursor: null,
      },
    );
    rpc2.respond('dgB', txResponse('dgB', { checkpoint: 90_000_001, timestampMs: 1_700_000_200_000 }));
    const result = await makeAdapter(rpc2).ingest([wallet], { db });
    expect(result.upserted).toBe(1);
    expect(rpc2.txCalls).toEqual(['dgB']);
  });

  it('stops paging a pass once digests fall before the since bound (ms vs s)', async () => {
    const { db } = createTestDb();
    const rpc = new FakeSuiRpc();
    rpc.setPages(
      { FromAddress: OWN },
      { data: [summary('dgA', 1_700_000_300_000)], hasNextPage: true, nextCursor: 'dgA' },
      { data: [summary('dgB', 1_700_000_200_000)], hasNextPage: true, nextCursor: 'dgB' },
      { data: [summary('dgC', 1_700_000_100_000)], hasNextPage: true, nextCursor: 'dgC' },
    );
    rpc.respond('dgA', txResponse('dgA', { checkpoint: 90_000_002, timestampMs: 1_700_000_300_000 }));
    rpc.respond('dgB', txResponse('dgB', { checkpoint: 90_000_001, timestampMs: 1_700_000_200_000 }));

    const result = await makeAdapter(rpc, { pageSize: 1 }).ingest([wallet], {
      db,
      since: 1_700_000_150,
    });

    expect(result).toEqual({ fetched: 2, upserted: 2 });
    expect(rpc.txCalls.sort()).toEqual(['dgA', 'dgB']);
    // FromAddress pass stopped at dgC; ToAddress pass still ran.
    expect(rpc.queryCalls.filter((c) => c.filter.startsWith('from:'))).toHaveLength(3);
    expect(rpc.queryCalls.filter((c) => c.filter.startsWith('to:'))).toHaveLength(1);
  });

  it('emits one gas:fee event (computation + storage - rebate) when the sender is an own wallet', async () => {
    const { db } = createTestDb();
    const rpc = new FakeSuiRpc();
    rpc.setPages(
      { FromAddress: OWN },
      {
        data: [summary('dgA', 1_700_000_300_000), summary('dgB', 1_700_000_200_000)],
        hasNextPage: false,
        nextCursor: null,
      },
    );
    rpc.respond(
      'dgA',
      txResponse('dgA', {
        checkpoint: 90_000_001,
        timestampMs: 1_700_000_300_000,
        sender: OWN,
        computationCost: '750000',
        storageCost: '2964000',
        storageRebate: '2433564',
      }),
    );
    rpc.respond(
      'dgB',
      txResponse('dgB', { checkpoint: 90_000_000, timestampMs: 1_700_000_200_000, sender: FOREIGN }),
    );

    await makeAdapter(rpc).ingest([wallet], { db });

    const gasRows = db.select().from(events).all();
    expect(gasRows).toHaveLength(1); // foreign sender emits nothing
    const gas = gasRows[0];
    expect(gas.txHash).toBe('dgA');
    expect(gas.type).toBe('gas');
    expect(gas.subtype).toBe('fee');
    expect(gas.logIndex).toBe(-1); // sentinel for ingest-time gas rows
    expect(gas.emissionSeq).toBe(0);
    expect(gas.wallet).toBe(OWN);
    expect(gas.sentAsset).toBe('SUI');
    expect(gas.sentAmount).toBe(750_000n + 2_964_000n - 2_433_564n); // 1_280_436 MIST
    expect(gas.handlerId).toBe('sui_ingest_gas');
    expect(gas.timestamp).toBe(1_700_000_300);
  });

  it('records a net storage rebate (rebate > costs) as a received amount, not a negative sent', async () => {
    const { db } = createTestDb();
    const rpc = new FakeSuiRpc();
    rpc.setPages(
      { FromAddress: OWN },
      { data: [summary('dgA', 1_700_000_300_000)], hasNextPage: false, nextCursor: null },
    );
    rpc.respond(
      'dgA',
      txResponse('dgA', {
        checkpoint: 90_000_000,
        timestampMs: 1_700_000_300_000,
        computationCost: '750000',
        storageCost: '988000',
        storageRebate: '5000000', // object deletions refund more than the tx cost
      }),
    );

    await makeAdapter(rpc).ingest([wallet], { db });

    const gas = db.select().from(events).all()[0];
    expect(gas.type).toBe('gas');
    expect(gas.sentAsset).toBeNull();
    expect(gas.sentAmount).toBeNull();
    expect(gas.receivedAsset).toBe('SUI');
    expect(gas.receivedAmount).toBe(5_000_000n - 750_000n - 988_000n); // 3_262_000 MIST refund
  });

  it('re-running ingest keeps gas events unique per tx', async () => {
    const { db } = createTestDb();
    for (let run = 0; run < 2; run += 1) {
      const rpc = new FakeSuiRpc();
      rpc.setPages(
        { FromAddress: OWN },
        { data: [summary('dgA', 1_700_000_100_000)], hasNextPage: false, nextCursor: null },
      );
      rpc.respond('dgA', txResponse('dgA', { checkpoint: 90_000_000, timestampMs: 1_700_000_100_000 }));
      await makeAdapter(rpc, run === 1 ? { forceRefetch: true } : {}).ingest([wallet], { db });
    }
    expect(db.select().from(events).where(eq(events.txHash, 'dgA')).all()).toHaveLength(1);
  });
});

describe('chain registry wiring', () => {
  it('registers the sui ingest adapter in the default registry', () => {
    const adapter = createDefaultChainRegistry().get('sui');
    expect(adapter).toBeDefined();
    expect(adapter?.chain).toBe('sui');
  });
});
