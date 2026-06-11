import { describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { events, rawTxs } from '../../../db/schema';
import { createDefaultChainRegistry } from '../../../src/chains/registry';
import {
  createSolanaIngestAdapter,
  toJsonSafe,
  type SignatureInfo,
  type SolanaRpcLike,
} from '../../../src/chains/solana/ingest';
import type { Wallet } from '../../../src/config/wallets-loader';
import { createTestDb } from '../../helpers/db';

// Synthetic infra tests (rate limiting, pagination, idempotency) — protocol
// handlers use real fixtures per the test-first rule; ingest plumbing does not.
const OWN = 'OwnWa11etAddre55Synthetic1111111111111111111';
const FOREIGN = 'ForeignFeePayerSynthetic22222222222222222222';

const wallet: Wallet = { chain: 'solana', address: OWN, label: 'phantom-test', status: 'active' };

function sigInfo(signature: string, slot: number, blockTime: number | null): SignatureInfo {
  return { signature, slot: BigInt(slot), blockTime: blockTime === null ? null : BigInt(blockTime), err: null };
}

/** Minimal jsonParsed-shaped getTransaction response. */
function txResponse(
  signature: string,
  opts: { slot: number; blockTime: number; fee?: number | bigint; feePayer?: string },
): unknown {
  return {
    slot: BigInt(opts.slot),
    blockTime: BigInt(opts.blockTime),
    meta: { err: null, fee: BigInt(opts.fee ?? 5000), innerInstructions: [], logMessages: [] },
    transaction: {
      message: {
        accountKeys: [{ pubkey: opts.feePayer ?? OWN, signer: true, writable: true, source: 'transaction' }],
        instructions: [],
      },
      signatures: [signature],
    },
    version: 0,
  };
}

class FakeRpc implements SolanaRpcLike {
  sigPages: SignatureInfo[][] = [];
  sigCalls: Array<{ address: string; before: string | undefined }> = [];
  /** Per-signature queue of responses; an Error entry rejects that attempt. */
  txResponses = new Map<string, Array<unknown>>();
  txCalls: string[] = [];

  respond(signature: string, ...responses: Array<unknown>): void {
    this.txResponses.set(signature, responses);
  }

  getSignaturesForAddress(address: string, config?: { before?: string; limit?: number }) {
    return {
      send: async (): Promise<readonly SignatureInfo[]> => {
        this.sigCalls.push({ address, before: config?.before });
        return this.sigPages.shift() ?? [];
      },
    };
  }

  getTransaction(signature: string) {
    return {
      send: async (): Promise<unknown> => {
        this.txCalls.push(signature);
        const queue = this.txResponses.get(signature);
        if (queue === undefined || queue.length === 0) {
          throw new Error(`FakeRpc: no scripted response for ${signature}`);
        }
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    };
  }
}

function makeAdapter(rpc: FakeRpc, overrides: Record<string, unknown> = {}) {
  return createSolanaIngestAdapter({
    rpc,
    pageSize: 2,
    minRequestIntervalMs: 0,
    maxRetries: 0,
    sleep: async () => {},
    log: () => {},
    ...overrides,
  });
}

describe('solana ingest adapter', () => {
  it('paginates signatures with a before cursor until a short page, storing raw txs', async () => {
    const { db } = createTestDb();
    const rpc = new FakeRpc();
    rpc.sigPages = [
      [sigInfo('sig3', 303, 1_700_000_300), sigInfo('sig2', 302, 1_700_000_200)],
      [sigInfo('sig1', 301, 1_700_000_100)],
    ];
    rpc.respond('sig3', txResponse('sig3', { slot: 303, blockTime: 1_700_000_300 }));
    rpc.respond('sig2', txResponse('sig2', { slot: 302, blockTime: 1_700_000_200 }));
    rpc.respond('sig1', txResponse('sig1', { slot: 301, blockTime: 1_700_000_100 }));

    const result = await makeAdapter(rpc).ingest([wallet], { db });

    expect(result).toEqual({ fetched: 3, upserted: 3 });
    expect(rpc.sigCalls).toEqual([
      { address: OWN, before: undefined },
      { address: OWN, before: 'sig2' },
    ]);
    const rows = db.select().from(rawTxs).all();
    expect(rows.map((r) => r.txHash).sort()).toEqual(['sig1', 'sig2', 'sig3']);
    const sig3 = rows.find((r) => r.txHash === 'sig3');
    expect(sig3?.chain).toBe('solana');
    expect(sig3?.blockNumber).toBe(303);
    expect(sig3?.blockTimestamp).toBe(1_700_000_300);
  });

  it('is idempotent — rerun fetches only signatures missing from raw_txs', async () => {
    const { db } = createTestDb();
    db.insert(rawTxs)
      .values({
        chain: 'solana',
        txHash: 'sig2',
        blockNumber: 302,
        blockTimestamp: 1_700_000_200,
        rawJson: { already: 'stored' },
        fetchedAt: 1_700_000_900,
      })
      .run();

    const rpc = new FakeRpc();
    rpc.sigPages = [
      [sigInfo('sig3', 303, 1_700_000_300), sigInfo('sig2', 302, 1_700_000_200)],
      [sigInfo('sig1', 301, 1_700_000_100)],
    ];
    rpc.respond('sig3', txResponse('sig3', { slot: 303, blockTime: 1_700_000_300 }));
    rpc.respond('sig1', txResponse('sig1', { slot: 301, blockTime: 1_700_000_100 }));

    const result = await makeAdapter(rpc).ingest([wallet], { db });

    expect(result).toEqual({ fetched: 3, upserted: 2 });
    expect(rpc.txCalls.sort()).toEqual(['sig1', 'sig3']); // sig2 skipped
    expect(db.select().from(rawTxs).all()).toHaveLength(3);
  });

  it('retries with exponential backoff on 429 responses', async () => {
    const { db } = createTestDb();
    const rpc = new FakeRpc();
    rpc.sigPages = [[sigInfo('sig1', 301, 1_700_000_100)]];
    rpc.respond(
      'sig1',
      new Error('HTTP error (429): Too Many Requests'),
      new Error('HTTP error (429): Too Many Requests'),
      txResponse('sig1', { slot: 301, blockTime: 1_700_000_100 }),
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
    expect(rpc.txCalls).toEqual(['sig1', 'sig1', 'sig1']);
    expect(sleeps).toEqual([100, 200]); // exponential backoff
  });

  it('does not retry non-retryable errors and flushes prior progress (resumable)', async () => {
    const { db } = createTestDb();
    const rpc = new FakeRpc();
    rpc.sigPages = [[sigInfo('sig3', 303, 1_700_000_300), sigInfo('sig2', 302, 1_700_000_200)]];
    rpc.respond('sig3', txResponse('sig3', { slot: 303, blockTime: 1_700_000_300 }));
    rpc.respond('sig2', new Error('invalid params'));

    await expect(makeAdapter(rpc, { flushEvery: 1 }).ingest([wallet], { db })).rejects.toThrow(
      'invalid params',
    );
    // sig3 was flushed before the failure — a rerun resumes from there.
    expect(db.select().from(rawTxs).all().map((r) => r.txHash)).toEqual(['sig3']);

    const rpc2 = new FakeRpc();
    rpc2.sigPages = [[sigInfo('sig3', 303, 1_700_000_300), sigInfo('sig2', 302, 1_700_000_200)]];
    rpc2.respond('sig2', txResponse('sig2', { slot: 302, blockTime: 1_700_000_200 }));
    const result = await makeAdapter(rpc2).ingest([wallet], { db });
    expect(result.upserted).toBe(1);
    expect(rpc2.txCalls).toEqual(['sig2']);
  });

  it('stops paging once signatures fall before the since bound', async () => {
    const { db } = createTestDb();
    const rpc = new FakeRpc();
    rpc.sigPages = [
      [sigInfo('sig3', 303, 1_700_000_300)],
      [sigInfo('sig2', 302, 1_700_000_200)],
      [sigInfo('sig1', 301, 1_700_000_100)],
    ];
    rpc.respond('sig3', txResponse('sig3', { slot: 303, blockTime: 1_700_000_300 }));
    rpc.respond('sig2', txResponse('sig2', { slot: 302, blockTime: 1_700_000_200 }));

    const result = await makeAdapter(rpc, { pageSize: 1 }).ingest([wallet], {
      db,
      since: 1_700_000_150,
    });

    expect(result).toEqual({ fetched: 2, upserted: 2 });
    expect(rpc.txCalls.sort()).toEqual(['sig2', 'sig3']);
  });

  it('skips signatures whose transaction lookup returns null', async () => {
    const { db } = createTestDb();
    const rpc = new FakeRpc();
    rpc.sigPages = [[sigInfo('sig2', 302, 1_700_000_200), sigInfo('sig1', 301, 1_700_000_100)]];
    rpc.respond('sig2', null);
    rpc.respond('sig1', txResponse('sig1', { slot: 301, blockTime: 1_700_000_100 }));

    const result = await makeAdapter(rpc).ingest([wallet], { db });

    expect(result).toEqual({ fetched: 2, upserted: 1 });
    expect(db.select().from(rawTxs).all().map((r) => r.txHash)).toEqual(['sig1']);
  });

  it('emits one gas:fee event per ingested tx when the fee payer is an own wallet', async () => {
    const { db } = createTestDb();
    const rpc = new FakeRpc();
    rpc.sigPages = [[sigInfo('sig2', 302, 1_700_000_200), sigInfo('sig1', 301, 1_700_000_100)]];
    rpc.respond('sig2', txResponse('sig2', { slot: 302, blockTime: 1_700_000_200, fee: 7001, feePayer: OWN }));
    rpc.respond('sig1', txResponse('sig1', { slot: 301, blockTime: 1_700_000_100, feePayer: FOREIGN }));

    await makeAdapter(rpc).ingest([wallet], { db });

    const gasRows = db.select().from(events).all();
    expect(gasRows).toHaveLength(1); // foreign fee payer emits nothing
    const gas = gasRows[0];
    expect(gas.txHash).toBe('sig2');
    expect(gas.type).toBe('gas');
    expect(gas.subtype).toBe('fee');
    expect(gas.logIndex).toBe(-1); // sentinel for ingest-time gas rows
    expect(gas.emissionSeq).toBe(0);
    expect(gas.wallet).toBe(OWN);
    expect(gas.sentAsset).toBe('SOL');
    expect(gas.sentAmount).toBe(7001n);
    expect(gas.handlerId).toBe('solana_ingest_gas');
    expect(gas.timestamp).toBe(1_700_000_200);
  });

  it('re-running ingest keeps gas events unique per tx', async () => {
    const { db } = createTestDb();
    const page = [sigInfo('sig1', 301, 1_700_000_100)];
    for (let run = 0; run < 2; run += 1) {
      const rpc = new FakeRpc();
      rpc.sigPages = [page.slice()];
      rpc.respond('sig1', txResponse('sig1', { slot: 301, blockTime: 1_700_000_100 }));
      await makeAdapter(rpc, run === 1 ? { forceRefetch: true } : {}).ingest([wallet], { db });
    }
    expect(db.select().from(events).where(eq(events.txHash, 'sig1')).all()).toHaveLength(1);
  });
});

describe('toJsonSafe', () => {
  it('converts safe bigints to numbers and oversized bigints to decimal strings', () => {
    const input = {
      slot: 354_550_000n,
      lamports: 2n ** 63n,
      nested: [{ fee: 5000n }, 'text', null],
      plain: 7,
    };
    expect(toJsonSafe(input)).toEqual({
      slot: 354_550_000,
      lamports: '9223372036854775808',
      nested: [{ fee: 5000 }, 'text', null],
      plain: 7,
    });
    // Result must be JSON.stringify-safe (drizzle json column does the stringify).
    expect(() => JSON.stringify(toJsonSafe(input))).not.toThrow();
  });
});

describe('chain registry wiring', () => {
  it('registers the solana ingest adapter in the default registry', () => {
    const adapter = createDefaultChainRegistry().get('solana');
    expect(adapter).toBeDefined();
    expect(adapter?.chain).toBe('solana');
  });
});
