import { describe, expect, test } from 'bun:test';
import { createTestDb } from '../../helpers/db';
import {
  BASE_INGEST_GAS_HANDLER_ID,
  baseIngestAdapter,
  buildRawTxRow,
  computeGasFeeWei,
  enumerateAssetTransfers,
  gasEventRowFor,
  ingestBase,
  sickleImplementationOf,
  storeBundles,
  withBackoff,
  type AlchemyAssetTransfer,
  type BaseTxBundle,
  type RpcRequestFn,
} from '../../../src/chains/base/ingest';

// ---------------------------------------------------------------------------
// Synthetic helpers — infrastructure tests only (protocol handlers use real
// fixtures under tests/fixtures/base/). Addresses below are made up.
// ---------------------------------------------------------------------------

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const SICKLE = '0x3333333333333333333333333333333333333333';
// vfat's public, verified Sickle implementation on Base (shared infra, not a wallet).
const SICKLE_IMPL = '0xfff75d099baee29f447866bc5299cd67c04761c8';
const SICKLE_PROXY_CODE = `0x363d3d373d3d3d363d73${SICKLE_IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`;

function makeTransfer(overrides: Partial<AlchemyAssetTransfer> = {}): AlchemyAssetTransfer {
  return {
    hash: '0xaaa1',
    blockNum: '0x64', // 100
    from: OWNER,
    to: OTHER,
    category: 'erc20',
    metadata: { blockTimestamp: '2025-10-19T12:00:00.000Z' },
    ...overrides,
  };
}

function makeBundle(overrides: Partial<BaseTxBundle> = {}): BaseTxBundle {
  return {
    hash: '0xaaa1',
    tx: {
      hash: '0xaaa1',
      from: OWNER,
      to: OTHER,
      blockNumber: '0x64',
      value: '0x0',
      input: '0x',
      gas: '0x5208',
      nonce: '0x1',
      transactionIndex: '0x0',
    },
    receipt: {
      transactionHash: '0xaaa1',
      status: '0x1',
      gasUsed: '0x5208',
      effectiveGasPrice: '0x3b9aca00', // 1 gwei
      l1Fee: '0x64', // 100 wei (OP-stack L1 data fee)
      blockNumber: '0x64',
      from: OWNER,
      to: OTHER,
      contractAddress: null,
      logs: [],
    },
    blockTimestamp: 1_760_875_200,
    transfers: [makeTransfer()],
    addresses: [OWNER],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// withBackoff — exponential retry on 429 (issue #5: rate-limit handler)
// ---------------------------------------------------------------------------

describe('withBackoff', () => {
  test('retries on 429 message with exponential delays, then succeeds', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const result = await withBackoff(
      () => {
        attempts += 1;
        if (attempts < 3) throw new Error('HTTP request failed: 429 Too Many Requests');
        return Promise.resolve('ok');
      },
      { baseMs: 100, retries: 5, sleep: (ms) => void delays.push(ms) },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  test('retries on error objects carrying status 429 (viem HttpRequestError shape)', async () => {
    let attempts = 0;
    const err = Object.assign(new Error('request failed'), { status: 429 });
    const result = await withBackoff(
      () => {
        attempts += 1;
        if (attempts === 1) throw err;
        return Promise.resolve(42);
      },
      { baseMs: 1, retries: 2, sleep: () => undefined },
    );
    expect(result).toBe(42);
    expect(attempts).toBe(2);
  });

  test('gives up after exhausting retries', async () => {
    let attempts = 0;
    await expect(
      withBackoff(
        () => {
          attempts += 1;
          throw new Error('429 rate limit');
        },
        { baseMs: 1, retries: 2, sleep: () => undefined },
      ),
    ).rejects.toThrow('429');
    expect(attempts).toBe(3); // initial + 2 retries
  });

  test('rethrows non-rate-limit errors immediately', async () => {
    let attempts = 0;
    await expect(
      withBackoff(
        () => {
          attempts += 1;
          throw new Error('execution reverted');
        },
        { baseMs: 1, retries: 5, sleep: () => undefined },
      ),
    ).rejects.toThrow('execution reverted');
    expect(attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeGasFeeWei — gasUsed * effectiveGasPrice + l1Fee (OP-stack)
// ---------------------------------------------------------------------------

describe('computeGasFeeWei', () => {
  test('includes the OP-stack l1Fee when present', () => {
    expect(
      computeGasFeeWei({ gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', l1Fee: '0x64' }),
    ).toBe(21_000n * 1_000_000_000n + 100n);
  });

  test('works without l1Fee', () => {
    expect(computeGasFeeWei({ gasUsed: '0x2', effectiveGasPrice: '0x3' })).toBe(6n);
  });

  test('treats null l1Fee as zero', () => {
    expect(computeGasFeeWei({ gasUsed: '0x2', effectiveGasPrice: '0x3', l1Fee: null })).toBe(6n);
  });
});

// ---------------------------------------------------------------------------
// buildRawTxRow / gasEventRowFor — row shapes
// ---------------------------------------------------------------------------

describe('buildRawTxRow', () => {
  test('maps a bundle to a raw_txs row keyed (base, hash)', () => {
    const row = buildRawTxRow(makeBundle(), 1_800_000_000);
    expect(row.chain).toBe('base');
    expect(row.txHash).toBe('0xaaa1');
    expect(row.blockNumber).toBe(100);
    expect(row.blockTimestamp).toBe(1_760_875_200);
    expect(row.fetchedAt).toBe(1_800_000_000);
    const json = row.rawJson as Record<string, unknown>;
    expect(json.source).toBe('alchemy');
    expect(json.tx).toBeDefined();
    expect(json.receipt).toBeDefined();
    expect(json.transfers).toBeDefined();
    expect(json.addresses).toEqual([OWNER]);
  });
});

describe('gasEventRowFor', () => {
  test('emits one gas:fee event with logIndex -1 sentinel, wallet = lowercased tx.from', () => {
    const bundle = makeBundle({
      tx: { ...makeBundle().tx, from: OWNER.toUpperCase().replace('0X', '0x') },
    });
    const event = gasEventRowFor(bundle);
    expect(event.chain).toBe('base');
    expect(event.txHash).toBe('0xaaa1');
    expect(event.logIndex).toBe(-1);
    expect(event.emissionSeq).toBe(0);
    expect(event.type).toBe('gas');
    expect(event.subtype).toBe('fee');
    expect(event.wallet).toBe(OWNER);
    expect(event.sentAsset).toBe('ETH');
    expect(event.sentAmount).toBe(21_000n * 1_000_000_000n + 100n);
    expect(event.receivedAsset).toBeUndefined();
    expect(event.timestamp).toBe(1_760_875_200);
    expect(event.handlerId).toBe(BASE_INGEST_GAS_HANDLER_ID);
  });
});

// ---------------------------------------------------------------------------
// sickleImplementationOf — EIP-1167 proxy detection (vfat Sickle discovery)
// ---------------------------------------------------------------------------

describe('sickleImplementationOf', () => {
  test('recognises an EIP-1167 minimal proxy to the known Sickle implementation', () => {
    expect(sickleImplementationOf(SICKLE_PROXY_CODE)).toBe(SICKLE_IMPL);
  });

  test('returns null for empty / EOA code', () => {
    expect(sickleImplementationOf('0x')).toBeNull();
    expect(sickleImplementationOf(null)).toBeNull();
    expect(sickleImplementationOf(undefined)).toBeNull();
  });

  test('returns null for a minimal proxy pointing at an unknown implementation', () => {
    const code = `0x363d3d373d3d3d363d73${'ab'.repeat(20)}5af43d82803e903d91602b57fd5bf3`;
    expect(sickleImplementationOf(code)).toBeNull();
  });

  test('returns null for ordinary contract bytecode', () => {
    expect(sickleImplementationOf('0x6080604052348015600e575f5ffd5b')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// discoverSickles — bytecode shape AND ownership must both verify
// ---------------------------------------------------------------------------

describe('discoverSickles', () => {
  // A third party's Sickle (same verified bytecode, foreign owner) that ever
  // appears as a transfer counterparty must NOT be enumerated as ours —
  // review finding: bytecode-only verification would ingest its entire
  // history and attribute its LP income to the owner.
  const FOREIGN_SICKLE = '0x4444444444444444444444444444444444444444';

  test('keeps only proxies whose owner() is a configured wallet', async () => {
    const calls: string[] = [];
    const request: RpcRequestFn = (args) => {
      if (args.method === 'eth_getCode') {
        const [address] = args.params as [string, string];
        return Promise.resolve(
          [SICKLE, FOREIGN_SICKLE].includes(address) ? SICKLE_PROXY_CODE : '0x',
        );
      }
      if (args.method === 'eth_call') {
        const [call] = args.params as [{ to: string; data: string }, string];
        calls.push(call.to);
        expect(call.data).toBe('0x8da5cb5b'); // owner() — SickleStorage public getter
        return Promise.resolve(pad32(call.to === SICKLE ? OWNER : OTHER));
      }
      throw new Error(`unexpected method ${args.method}`);
    };

    const { discoverSickles } = await import('../../../src/chains/base/ingest');
    const sickles = await discoverSickles(
      request,
      new Set([SICKLE, FOREIGN_SICKLE, OTHER]),
      new Set([OWNER]),
    );
    expect(sickles).toEqual([SICKLE]);
    // Ownership was actually probed for both bytecode-verified candidates.
    expect(calls.sort()).toEqual([SICKLE, FOREIGN_SICKLE].sort());
  });

  test('excludes a Sickle whose owner() call fails to return an address', async () => {
    const request: RpcRequestFn = (args) => {
      if (args.method === 'eth_getCode') return Promise.resolve(SICKLE_PROXY_CODE);
      if (args.method === 'eth_call') return Promise.resolve('0x');
      throw new Error(`unexpected method ${args.method}`);
    };
    const { discoverSickles } = await import('../../../src/chains/base/ingest');
    const sickles = await discoverSickles(request, new Set([SICKLE]), new Set([OWNER]));
    expect(sickles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// enumerateAssetTransfers — both directions, all categories, pagination
// ---------------------------------------------------------------------------

interface GetAssetTransfersParams {
  fromAddress?: string;
  toAddress?: string;
  fromBlock?: string;
  category?: string[];
  withMetadata?: boolean;
  pageKey?: string;
}

describe('enumerateAssetTransfers', () => {
  test('queries both directions with all categories and follows pageKeys', async () => {
    const seen: GetAssetTransfersParams[] = [];
    const t1 = makeTransfer({ hash: '0x01' });
    const t2 = makeTransfer({ hash: '0x02' });
    const t3 = makeTransfer({ hash: '0x03', from: OTHER, to: OWNER });
    const request: RpcRequestFn = (args) => {
      expect(args.method).toBe('alchemy_getAssetTransfers');
      const params = (args.params as GetAssetTransfersParams[])[0];
      seen.push(params);
      if (params.fromAddress === OWNER) {
        if (params.pageKey === undefined)
          return Promise.resolve({ transfers: [t1], pageKey: 'page-2' });
        return Promise.resolve({ transfers: [t2] });
      }
      expect(params.toAddress).toBe(OWNER);
      return Promise.resolve({ transfers: [t3] });
    };
    const transfers = await enumerateAssetTransfers(request, OWNER, 0);
    expect(transfers.map((t) => t.hash).sort()).toEqual(['0x01', '0x02', '0x03']);
    expect(seen).toHaveLength(3);
    for (const params of seen) {
      expect(params.withMetadata).toBe(true);
      expect(params.category).toEqual(
        expect.arrayContaining(['external', 'internal', 'erc20', 'erc721', 'erc1155']),
      );
    }
    expect(seen[1]?.pageKey).toBe('page-2');
    expect(seen[0]?.fromBlock).toBe('0x0');
  });

  test('drops the internal category and retries when the RPC rejects it', async () => {
    const categoriesSeen: string[][] = [];
    const request: RpcRequestFn = (args) => {
      const params = (args.params as GetAssetTransfersParams[])[0];
      categoriesSeen.push(params.category ?? []);
      if (params.category?.includes('internal')) {
        throw new Error('Category internal is not supported on this network');
      }
      return Promise.resolve({ transfers: [makeTransfer()] });
    };
    const transfers = await enumerateAssetTransfers(request, OWNER, 0);
    expect(transfers.length).toBeGreaterThan(0);
    expect(categoriesSeen.some((c) => !c.includes('internal'))).toBe(true);
  });

  test('does not misread an unrelated error that merely echoes the category list', async () => {
    // viem error messages include the request body — "category" appears in
    // the echo even when the actual problem is unrelated (e.g. network not
    // enabled for the app). The fallback must not strip `internal` for those.
    const request: RpcRequestFn = (args) => {
      const params = (args.params as GetAssetTransfersParams[])[0];
      throw new Error(
        `JSON is not a valid request object. Request body: {"category":${JSON.stringify(params.category)}} ` +
          'Details: BASE_MAINNET is not enabled for this app.',
      );
    };
    await expect(enumerateAssetTransfers(request, OWNER, 0)).rejects.toThrow('not enabled');
  });
});

// ---------------------------------------------------------------------------
// enumerateViaLogs — public-RPC fallback (issue #5 original getLogs design)
// ---------------------------------------------------------------------------

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function makeLog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: '0x4200000000000000000000000000000000000006',
    topics: [TRANSFER_TOPIC, pad32(OWNER), pad32(OTHER)],
    data: '0x01',
    blockNumber: '0x64',
    blockTimestamp: '0x68f4d1c0', // Tenderly includes this per log
    transactionHash: '0xaaa1',
    logIndex: '0x0',
    ...overrides,
  };
}

function pad32(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

describe('enumerateViaLogs', () => {
  test('collects tx refs from ERC-20/721/1155 Transfer logs in both directions', async () => {
    const filtersSeen: Array<{ topics: unknown[] }> = [];
    const request: RpcRequestFn = (args) => {
      if (args.method === 'eth_blockNumber') return Promise.resolve('0xc8');
      expect(args.method).toBe('eth_getLogs');
      const filter = (args.params as Array<{ topics: unknown[] }>)[0]!;
      filtersSeen.push(filter);
      const [topic0, topic1, topic2] = filter.topics as Array<string | string[] | null>;
      if (topic0 === TRANSFER_TOPIC && topic1 === pad32(OWNER)) {
        return Promise.resolve([makeLog({ transactionHash: '0x01' })]);
      }
      if (topic0 === TRANSFER_TOPIC && topic2 === pad32(OWNER)) {
        return Promise.resolve([
          makeLog({ transactionHash: '0x02', topics: [TRANSFER_TOPIC, pad32(OTHER), pad32(OWNER)] }),
          // duplicate hash — must dedupe
          makeLog({ transactionHash: '0x01', topics: [TRANSFER_TOPIC, pad32(OTHER), pad32(OWNER)] }),
        ]);
      }
      return Promise.resolve([]);
    };
    const { enumerateViaLogs } = await import('../../../src/chains/base/ingest');
    const refs = await enumerateViaLogs(request, OWNER, 0);
    expect(refs.map((r) => r.hash).sort()).toEqual(['0x01', '0x02']);
    expect(refs[0]?.blockNum).toBe(100);
    expect(refs[0]?.timestamp).toBe(0x68f4d1c0);
    // ERC-1155 TransferSingle/TransferBatch use topic2=from / topic3=to.
    expect(filtersSeen.length).toBeGreaterThanOrEqual(6);
  });

  test('bisects the block range when the RPC rejects an oversized getLogs response', async () => {
    const ranges: Array<[number, number]> = [];
    const request: RpcRequestFn = (args) => {
      if (args.method === 'eth_blockNumber') return Promise.resolve('0x190'); // 400
      const filter = (args.params as Array<{ fromBlock: string; toBlock: string }>)[0]!;
      const from = Number(BigInt(filter.fromBlock));
      const to = Number(BigInt(filter.toBlock));
      ranges.push([from, to]);
      if (to - from > 100) throw new Error('Log response size exceeded');
      return Promise.resolve([makeLog({ transactionHash: `0x${from.toString(16)}` })]);
    };
    const { enumerateViaLogs } = await import('../../../src/chains/base/ingest');
    const refs = await enumerateViaLogs(request, OWNER, 0);
    expect(refs.length).toBeGreaterThan(0);
    // The initial full-range call failed and was halved at least once.
    expect(ranges.some(([f, t]) => t - f <= 100)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// storeBundles — idempotent persistence + exactly one gas event per raw tx
// ---------------------------------------------------------------------------

describe('storeBundles', () => {
  test('stores raw tx + exactly one gas:fee event per tx; rerun is idempotent', () => {
    const { db, sqlite } = createTestDb();
    const bundles = [makeBundle(), makeBundle({ hash: '0xbbb2' })];
    bundles[1]!.tx.hash = '0xbbb2';
    bundles[1]!.receipt.transactionHash = '0xbbb2';

    storeBundles(db, bundles);
    storeBundles(db, bundles); // idempotent rerun

    const rawCount = sqlite.query<{ n: number }, []>('SELECT count(*) n FROM raw_txs').get();
    expect(rawCount?.n).toBe(2);

    // Count-join: every raw_txs row has exactly one gas:fee event (issue #5).
    const joined = sqlite
      .query<{ tx_hash: string; n: number }, []>(
        `SELECT r.tx_hash, count(e.id) n
         FROM raw_txs r
         LEFT JOIN events e
           ON e.chain = r.chain AND e.tx_hash = r.tx_hash AND e.type = 'gas'
         GROUP BY r.tx_hash`,
      )
      .all();
    expect(joined).toHaveLength(2);
    for (const row of joined) expect(row.n).toBe(1);
  });

  test('merges the addresses array when the same tx is stored for another wallet', () => {
    const { db, sqlite } = createTestDb();
    storeBundles(db, [makeBundle({ addresses: [OWNER] })]);
    storeBundles(db, [makeBundle({ addresses: [SICKLE] })]);

    const row = sqlite
      .query<{ raw_json: string }, []>(`SELECT raw_json FROM raw_txs WHERE tx_hash = '0xaaa1'`)
      .get();
    const json = JSON.parse(row?.raw_json ?? '{}') as { addresses?: string[] };
    expect(json.addresses?.sort()).toEqual([OWNER, SICKLE].sort());
  });
});

// ---------------------------------------------------------------------------
// ingestBase — orchestration against a scripted fake RPC
// ---------------------------------------------------------------------------

function makeFakeRpc(): { request: RpcRequestFn; calls: Map<string, number> } {
  // World: OWNER does tx 0xaaa1 with OTHER and tx 0xccc3 with SICKLE (its vfat
  // proxy). The Sickle additionally does tx 0xddd4 with OTHER that never
  // touches OWNER — the ingest must still capture it.
  // Note the owner's NEWEST tx (0xaaa1, block 0x65) does not touch the
  // Sickle — incremental reruns must still re-enumerate the Sickle.
  const transfersByTarget: Record<string, AlchemyAssetTransfer[]> = {
    [OWNER]: [
      makeTransfer({ hash: '0xccc3', from: OWNER, to: SICKLE, blockNum: '0x64' }),
      makeTransfer({ hash: '0xaaa1', from: OWNER, to: OTHER, blockNum: '0x65' }),
    ],
    [SICKLE]: [
      makeTransfer({ hash: '0xccc3', from: OWNER, to: SICKLE, blockNum: '0x64' }),
      makeTransfer({ hash: '0xddd4', from: SICKLE, to: OTHER, blockNum: '0x66' }),
    ],
  };
  const calls = new Map<string, number>();
  const request: RpcRequestFn = (args) => {
    calls.set(args.method, (calls.get(args.method) ?? 0) + 1);
    if (args.method === 'alchemy_getAssetTransfers') {
      const params = (args.params as GetAssetTransfersParams[])[0]!;
      const target = (params.fromAddress ?? params.toAddress ?? '').toLowerCase();
      const fromBlock = Number(BigInt(params.fromBlock ?? '0x0'));
      const all = transfersByTarget[target] ?? [];
      const matches = all.filter(
        (t) =>
          Number(BigInt(t.blockNum)) >= fromBlock &&
          (params.fromAddress !== undefined
            ? t.from.toLowerCase() === target
            : (t.to ?? '').toLowerCase() === target),
      );
      return Promise.resolve({ transfers: matches });
    }
    if (args.method === 'eth_getCode') {
      const [address] = args.params as [string, string];
      return Promise.resolve(address.toLowerCase() === SICKLE ? SICKLE_PROXY_CODE : '0x');
    }
    if (args.method === 'eth_call') {
      // Sickle ownership probe: owner() returns the configured wallet.
      const [call] = args.params as [{ to: string; data: string }, string];
      if (call.data === '0x8da5cb5b' && call.to.toLowerCase() === SICKLE) {
        return Promise.resolve(pad32(OWNER));
      }
      return Promise.resolve('0x');
    }
    const blockOf = (hash: string): string =>
      [...Object.values(transfersByTarget)].flat().find((t) => t.hash === hash)?.blockNum ?? '0x64';
    if (args.method === 'eth_getTransactionByHash') {
      const [hash] = args.params as [string];
      calls.set(`tx:${hash}`, (calls.get(`tx:${hash}`) ?? 0) + 1);
      const bundle = makeBundle({ hash });
      return Promise.resolve({ ...bundle.tx, hash, blockNumber: blockOf(hash) });
    }
    if (args.method === 'eth_getTransactionReceipt') {
      const [hash] = args.params as [string];
      const bundle = makeBundle({ hash });
      return Promise.resolve({ ...bundle.receipt, transactionHash: hash, blockNumber: blockOf(hash) });
    }
    throw new Error(`unexpected method ${args.method}`);
  };
  return { request, calls };
}

describe('ingestBase', () => {
  test('captures wallet txs plus Sickle-only txs discovered via EIP-1167 probing', async () => {
    const { db, sqlite } = createTestDb();
    const { request } = makeFakeRpc();

    const result = await ingestBase(request, db, [OWNER], { log: () => undefined });
    expect(result.fetched).toBe(3);
    expect(result.upserted).toBe(3);

    const hashes = sqlite
      .query<{ tx_hash: string }, []>(`SELECT tx_hash FROM raw_txs ORDER BY tx_hash`)
      .all()
      .map((r) => r.tx_hash);
    expect(hashes).toEqual(['0xaaa1', '0xccc3', '0xddd4']);

    // The sickle-only tx is tagged with the sickle address for cursoring.
    const sickleTx = sqlite
      .query<{ raw_json: string }, []>(`SELECT raw_json FROM raw_txs WHERE tx_hash = '0xddd4'`)
      .get();
    const json = JSON.parse(sickleTx?.raw_json ?? '{}') as { addresses?: string[] };
    expect(json.addresses).toEqual([SICKLE]);

    const gasCount = sqlite
      .query<{ n: number }, []>(`SELECT count(*) n FROM events WHERE type = 'gas'`)
      .get();
    expect(gasCount?.n).toBe(3);
  });

  test('falls back to the public-RPC getLogs path when Alchemy lacks Base access', async () => {
    const { db, sqlite } = createTestDb();
    const primary: RpcRequestFn = (args) => {
      if (args.method === 'alchemy_getAssetTransfers') {
        throw new Error('BASE_MAINNET is not enabled for this app.');
      }
      throw new Error(`primary should not serve ${args.method}`);
    };
    const fallback: RpcRequestFn = (args) => {
      if (args.method === 'eth_blockNumber') return Promise.resolve('0xc8');
      if (args.method === 'eth_getLogs') {
        const filter = (args.params as Array<{ topics: Array<string | null> }>)[0]!;
        const [, topic1, topic2] = filter.topics;
        if (topic1 === pad32(OWNER) || topic2 === pad32(OWNER)) {
          return Promise.resolve([makeLog({ transactionHash: '0xaaa1' })]);
        }
        return Promise.resolve([]);
      }
      if (args.method === 'eth_getCode') return Promise.resolve('0x');
      if (args.method === 'eth_getTransactionByHash') {
        return Promise.resolve(makeBundle({ hash: '0xaaa1' }).tx);
      }
      if (args.method === 'eth_getTransactionReceipt') {
        return Promise.resolve(makeBundle({ hash: '0xaaa1' }).receipt);
      }
      throw new Error(`unexpected fallback method ${args.method}`);
    };

    const result = await ingestBase(primary, db, [OWNER], {
      log: () => undefined,
      fallbackRequest: fallback,
    });
    expect(result.upserted).toBe(1);
    const row = sqlite
      .query<{ tx_hash: string }, []>(`SELECT tx_hash FROM raw_txs`)
      .get();
    expect(row?.tx_hash).toBe('0xaaa1');
  });

  test('rerun skips refetching already-stored txs', async () => {
    const { db } = createTestDb();
    const first = makeFakeRpc();
    await ingestBase(first.request, db, [OWNER], { log: () => undefined });
    expect(first.calls.get('eth_getTransactionByHash')).toBe(3);

    const second = makeFakeRpc();
    const result = await ingestBase(second.request, db, [OWNER], { log: () => undefined });
    expect(second.calls.get('eth_getTransactionByHash') ?? 0).toBe(0);
    expect(result.upserted).toBe(0);
    // The previously discovered Sickle is re-enumerated even when no fresh
    // owner transfer touches it (1 owner + 1 sickle, 2 directions each).
    expect(second.calls.get('alchemy_getAssetTransfers')).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// adapter registration surface
// ---------------------------------------------------------------------------

describe('baseIngestAdapter', () => {
  test('declares chain base', () => {
    expect(baseIngestAdapter.chain).toBe('base');
  });
});
