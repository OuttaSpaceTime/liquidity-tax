import { describe, it, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { createTestDb, type TestDb } from '../helpers/db';
import { transferLinks, unclassified } from '../../db/schema';
import { DecoderRegistry } from '../../src/decoder/registry';
import { runLinker } from '../../src/linker/run';
import { listLinksForAssetWallet } from '../../src/linker/repo';
import { makeRawTx, makeEvent, makeHandler, insertRawTx } from './helpers';

/**
 * SHA-256 over all events columns except the surrogate autoincrement `id`,
 * in physical insert order (rowid) — detects any byte-level drift across
 * re-decodes, including insert order.
 */
function sha256EventRows(sqlite: TestDb['sqlite'], chain: string, txHash: string): string {
  const rows = sqlite
    .query(
      `SELECT chain, tx_hash, log_index, emission_seq, timestamp, wallet, type, subtype,
              sent_asset, hex(sent_amount) AS sent_amount_hex,
              received_asset, hex(received_amount) AS received_amount_hex,
              price_usd_json, position_id, flags_json, handler_id, handler_version
       FROM events WHERE chain = ? AND tx_hash = ? ORDER BY id`,
    )
    .all(chain, txHash);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function eventCount(sqlite: TestDb['sqlite'], chain: string, txHash: string): number {
  const row = sqlite
    .query<
      { n: number },
      [string, string]
    >('SELECT count(*) AS n FROM events WHERE chain = ? AND tx_hash = ?')
    .get(chain, txHash);
  return row?.n ?? 0;
}

describe('DecoderRegistry.decodeAndPersist — idempotency', () => {
  it('throws when the raw tx is not ingested', () => {
    const { db } = createTestDb();
    const registry = new DecoderRegistry(db);
    expect(() => registry.decodeAndPersist('base', '0xmissing')).toThrow(/0xmissing/);
  });

  it('re-running decode yields byte-identical events rows (SHA-256)', () => {
    const { db, sqlite } = createTestDb();
    const raw = makeRawTx({ txHash: '0xidem' });
    insertRawTx(db, raw);

    const registry = new DecoderRegistry(db);
    registry.registerHandler(
      makeHandler({
        id: 'h1',
        result: {
          kind: 'ok',
          events: [
            makeEvent({
              handlerId: 'h1',
              txHash: '0xidem',
              logIndex: 0,
              sentAsset: 'WETH',
              sentAmount: 2n ** 70n,
              receivedAsset: 'USDC',
              receivedAmount: 1234n,
              priceUsd: { sent: '3000.12', source: 'coingecko' },
              flags: ['wrapped_native'],
            }),
            makeEvent({
              handlerId: 'h1',
              txHash: '0xidem',
              logIndex: 4,
              type: 'gas',
              subtype: 'fee',
            }),
          ],
        },
      }),
    );

    registry.decodeAndPersist('base', '0xidem');
    expect(eventCount(sqlite, 'base', '0xidem')).toBe(2);
    const first = sha256EventRows(sqlite, 'base', '0xidem');

    registry.decodeAndPersist('base', '0xidem');
    registry.decodeAndPersist('base', '0xidem');
    expect(eventCount(sqlite, 'base', '0xidem')).toBe(2);
    expect(sha256EventRows(sqlite, 'base', '0xidem')).toBe(first);
  });

  it('replaces events by tx on re-decode with an upgraded handler', () => {
    const { db, sqlite } = createTestDb();
    insertRawTx(db, makeRawTx({ txHash: '0xupgrade' }));

    const v1 = new DecoderRegistry(db);
    v1.registerHandler(
      makeHandler({
        id: 'h1',
        version: 1,
        result: {
          kind: 'ok',
          events: [
            makeEvent({ handlerId: 'h1', txHash: '0xupgrade', logIndex: 0 }),
            makeEvent({
              handlerId: 'h1',
              txHash: '0xupgrade',
              logIndex: 1,
              type: 'gas',
              subtype: 'fee',
            }),
          ],
        },
      }),
    );
    v1.decodeAndPersist('base', '0xupgrade');
    expect(eventCount(sqlite, 'base', '0xupgrade')).toBe(2);

    const v2 = new DecoderRegistry(db);
    v2.registerHandler(
      makeHandler({
        id: 'h1',
        version: 2,
        result: {
          kind: 'ok',
          events: [
            makeEvent({ handlerId: 'h1', handlerVersion: 2, txHash: '0xupgrade', logIndex: 0 }),
          ],
        },
      }),
    );
    v2.decodeAndPersist('base', '0xupgrade');

    expect(eventCount(sqlite, 'base', '0xupgrade')).toBe(1);
    const versions = sqlite
      .query<
        { handler_version: number },
        [string]
      >('SELECT handler_version FROM events WHERE tx_hash = ?')
      .all('0xupgrade');
    expect(versions.map((v) => v.handler_version)).toEqual([2]);
  });

  it('preserves ingest-time rows (log_index < 0, e.g. sui_ingest_gas) across re-decode', () => {
    const { db, sqlite } = createTestDb();
    insertRawTx(db, makeRawTx({ chain: 'sui', txHash: 'GasDigest1' }));
    // Ingest-time gas:fee row at the documented log_index = -1 sentinel
    // (src/chains/sui/ingest.ts — "outside event index space").
    sqlite
      .query(
        `INSERT INTO events (chain, tx_hash, log_index, emission_seq, timestamp, wallet,
                             type, subtype, sent_asset, handler_id, handler_version)
         VALUES ('sui', 'GasDigest1', -1, 0, 1700000000, '0xwallet',
                 'gas', 'fee', 'SUI', 'sui_ingest_gas', 1)`,
      )
      .run();

    const registry = new DecoderRegistry(db);
    registry.registerHandler(
      makeHandler({
        id: 'h1',
        chain: 'sui',
        result: {
          kind: 'ok',
          events: [makeEvent({ handlerId: 'h1', chain: 'sui', txHash: 'GasDigest1' })],
        },
      }),
    );
    registry.decodeAndPersist('sui', 'GasDigest1');
    registry.decodeAndPersist('sui', 'GasDigest1');

    const rows = sqlite
      .query<
        { handler_id: string; log_index: number },
        [string]
      >('SELECT handler_id, log_index FROM events WHERE tx_hash = ? ORDER BY log_index')
      .all('GasDigest1');
    expect(rows).toEqual([
      { handler_id: 'sui_ingest_gas', log_index: -1 },
      { handler_id: 'h1', log_index: 0 },
    ]);
  });

  it('preserves ingest-time rows when the tx decodes to unclassified', () => {
    const { db, sqlite } = createTestDb();
    insertRawTx(db, makeRawTx({ chain: 'sui', txHash: 'GasDigest2' }));
    sqlite
      .query(
        `INSERT INTO events (chain, tx_hash, log_index, emission_seq, timestamp, wallet,
                             type, subtype, sent_asset, handler_id, handler_version)
         VALUES ('sui', 'GasDigest2', -1, 0, 1700000000, '0xwallet',
                 'gas', 'fee', 'SUI', 'sui_ingest_gas', 1)`,
      )
      .run();

    const registry = new DecoderRegistry(db);
    const result = registry.decodeAndPersist('sui', 'GasDigest2');
    expect(result.status).toBe('unclassified');
    const rows = sqlite
      .query<{ handler_id: string }, [string]>('SELECT handler_id FROM events WHERE tx_hash = ?')
      .all('GasDigest2');
    expect(rows).toEqual([{ handler_id: 'sui_ingest_gas' }]);
  });

  it('preserves surrogate event ids on re-decode (natural-key upsert, not delete+insert)', () => {
    const { db, sqlite } = createTestDb();
    insertRawTx(db, makeRawTx({ txHash: '0xstableid' }));

    const registry = new DecoderRegistry(db);
    registry.registerHandler(
      makeHandler({
        id: 'h1',
        result: {
          kind: 'ok',
          events: [
            makeEvent({ handlerId: 'h1', txHash: '0xstableid', logIndex: 0 }),
            makeEvent({ handlerId: 'h1', txHash: '0xstableid', logIndex: 1 }),
          ],
        },
      }),
    );

    registry.decodeAndPersist('base', '0xstableid');
    const idsBefore = sqlite
      .query<{ id: number }, [string]>('SELECT id FROM events WHERE tx_hash = ? ORDER BY id')
      .all('0xstableid')
      .map((r) => r.id);
    expect(idsBefore).toHaveLength(2);

    registry.decodeAndPersist('base', '0xstableid');
    const idsAfter = sqlite
      .query<{ id: number }, [string]>('SELECT id FROM events WHERE tx_hash = ? ORDER BY id')
      .all('0xstableid')
      .map((r) => r.id);
    expect(idsAfter).toEqual(idsBefore);
  });

  it('keeps transfer_links and linker tags intact across a re-decode', () => {
    const { db } = createTestDb();
    insertRawTx(db, makeRawTx({ txHash: '0xout' }));
    insertRawTx(db, makeRawTx({ txHash: '0xin' }));

    const registry = new DecoderRegistry(db);
    registry.registerHandler(
      makeHandler({
        id: 'h1',
        decode: (raw) => ({
          kind: 'ok',
          events: [
            raw.txHash === '0xout'
              ? makeEvent({
                  handlerId: 'h1',
                  txHash: '0xout',
                  type: 'transfer',
                  subtype: 'send',
                  wallet: '0xwallet-a',
                  sentAsset: 'WETH',
                  sentAmount: 1000n,
                })
              : makeEvent({
                  handlerId: 'h1',
                  txHash: '0xin',
                  type: 'transfer',
                  subtype: 'receive',
                  wallet: '0xwallet-b',
                  receivedAsset: 'WETH',
                  receivedAmount: 1000n,
                }),
          ],
        }),
      }),
    );

    registry.decodeAndPersist('base', '0xout');
    registry.decodeAndPersist('base', '0xin');
    const summary = runLinker(db);
    expect(summary.written).toBe(1);
    expect(listLinksForAssetWallet(db, { asset: 'WETH', wallet: '0xwallet-a' })).toHaveLength(1);

    // Re-decode both txs (e.g. handler version bump): links must still join,
    // the linker must not re-match into duplicates, and the linker's
    // self_transfer retag + flag must survive.
    registry.decodeAndPersist('base', '0xout');
    registry.decodeAndPersist('base', '0xin');

    const links = listLinksForAssetWallet(db, { asset: 'WETH', wallet: '0xwallet-a' });
    expect(links).toHaveLength(1);
    expect(links[0].outEvent.subtype).toBe('self_transfer');
    expect(links[0].outEvent.flagsJson ?? []).toContain('self_transfer');
    expect(links[0].inEvent.subtype).toBe('self_transfer');

    const rerun = runLinker(db);
    expect(rerun.written).toBe(0);
    expect(db.select().from(transferLinks).all()).toHaveLength(1);
  });

  it('drops transfer_links whose events disappear on re-decode', () => {
    const { db } = createTestDb();
    insertRawTx(db, makeRawTx({ txHash: '0xout2' }));
    insertRawTx(db, makeRawTx({ txHash: '0xin2' }));

    const transferEvent = (txHash: string) =>
      txHash === '0xout2'
        ? makeEvent({
            handlerId: 'h1',
            txHash,
            type: 'transfer',
            subtype: 'send',
            wallet: '0xwallet-a',
            sentAsset: 'WETH',
            sentAmount: 1000n,
          })
        : makeEvent({
            handlerId: 'h1',
            txHash,
            type: 'transfer',
            subtype: 'receive',
            wallet: '0xwallet-b',
            receivedAsset: 'WETH',
            receivedAmount: 1000n,
          });

    const v1 = new DecoderRegistry(db);
    v1.registerHandler(
      makeHandler({ id: 'h1', decode: (raw) => ({ kind: 'ok', events: [transferEvent(raw.txHash)] }) }),
    );
    v1.decodeAndPersist('base', '0xout2');
    v1.decodeAndPersist('base', '0xin2');
    expect(runLinker(db).written).toBe(1);

    // v2 stops emitting anything for the out-tx — the link must not dangle.
    const v2 = new DecoderRegistry(db);
    v2.registerHandler(
      makeHandler({
        id: 'h1',
        decode: (raw) =>
          raw.txHash === '0xout2'
            ? { kind: 'skip' }
            : { kind: 'ok', events: [transferEvent(raw.txHash)] },
      }),
    );
    v2.decodeAndPersist('base', '0xout2');

    expect(db.select().from(transferLinks).all()).toHaveLength(0);
  });

  it('does not touch events of other txs', () => {
    const { db, sqlite } = createTestDb();
    insertRawTx(db, makeRawTx({ txHash: '0xa' }));
    insertRawTx(db, makeRawTx({ txHash: '0xb' }));
    const registry = new DecoderRegistry(db);
    registry.registerHandler(
      makeHandler({
        id: 'h1',
        decode: (raw) => ({
          kind: 'ok',
          events: [makeEvent({ handlerId: 'h1', txHash: raw.txHash })],
        }),
      }),
    );

    registry.decodeAndPersist('base', '0xa');
    registry.decodeAndPersist('base', '0xb');
    registry.decodeAndPersist('base', '0xa');
    expect(eventCount(sqlite, 'base', '0xa')).toBe(1);
    expect(eventCount(sqlite, 'base', '0xb')).toBe(1);
  });
});

describe('DecoderRegistry.decodeAndPersist — unclassified table', () => {
  it('writes an unclassified row with a non-empty reason when nothing matches', () => {
    const { db } = createTestDb();
    insertRawTx(db, makeRawTx({ txHash: '0xunknown' }));

    const registry = new DecoderRegistry(db);
    const result = registry.decodeAndPersist('base', '0xunknown');
    expect(result.status).toBe('unclassified');

    const rows = db.select().from(unclassified).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].txHash).toBe('0xunknown');
    expect(rows[0].reason.length).toBeGreaterThan(0);
    expect(rows[0].resolvedAt).toBeNull();
  });

  it('preserves first_seen_at and updates reason on repeated unclassified decodes', () => {
    const { db, sqlite } = createTestDb();
    insertRawTx(db, makeRawTx({ txHash: '0xstill' }));

    const registry = new DecoderRegistry(db);
    registry.decodeAndPersist('base', '0xstill');
    const before = db.select().from(unclassified).all()[0];
    // Force a visibly different firstSeenAt if it were re-written.
    sqlite.query("UPDATE unclassified SET first_seen_at = 1 WHERE tx_hash = '0xstill'").run();

    const registry2 = new DecoderRegistry(db);
    registry2.registerHandler(
      makeHandler({ id: 'h1', result: { kind: 'unclassified', reason: 'better reason' } }),
    );
    registry2.decodeAndPersist('base', '0xstill');

    const rows = db.select().from(unclassified).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].firstSeenAt).toBe(1);
    expect(rows[0].reason).toContain('better reason');
    expect(before.reason).not.toContain('better reason');
  });

  it('removes the unclassified row once a later decode classifies the tx', () => {
    const { db, sqlite } = createTestDb();
    insertRawTx(db, makeRawTx({ txHash: '0xlater' }));

    new DecoderRegistry(db).decodeAndPersist('base', '0xlater');
    expect(db.select().from(unclassified).all()).toHaveLength(1);

    const registry = new DecoderRegistry(db);
    registry.registerHandler(
      makeHandler({
        id: 'h1',
        result: { kind: 'ok', events: [makeEvent({ handlerId: 'h1', txHash: '0xlater' })] },
      }),
    );
    registry.decodeAndPersist('base', '0xlater');

    expect(db.select().from(unclassified).all()).toHaveLength(0);
    expect(eventCount(sqlite, 'base', '0xlater')).toBe(1);
  });

  it('keeps the unclassified row when one handler decodes but another reports a problem', () => {
    // Review finding: a multi-handler tx (e.g. a Sui PTB) where handler B hits
    // its conservative all-or-nothing guard must NOT be marked decoded by
    // handler A's events — and an existing unclassified row must never be
    // deleted while any handler still reports a problem for the tx.
    const { db, sqlite } = createTestDb();
    insertRawTx(db, makeRawTx({ txHash: '0xpartial' }));

    // First pass: only the confused handler exists — tx lands in the queue.
    const v1 = new DecoderRegistry(db);
    v1.registerHandler(
      makeHandler({ id: 'confused', result: { kind: 'unclassified', reason: 'guard tripped' } }),
    );
    v1.decodeAndPersist('base', '0xpartial');
    expect(db.select().from(unclassified).all()).toHaveLength(1);

    // Second pass: a second handler now decodes part of the tx, but the
    // confused handler still reports its problem.
    const v2 = new DecoderRegistry(db);
    v2.registerHandler(
      makeHandler({ id: 'confused', result: { kind: 'unclassified', reason: 'guard tripped' } }),
    );
    v2.registerHandler(
      makeHandler({
        id: 'confident',
        result: { kind: 'ok', events: [makeEvent({ handlerId: 'confident', txHash: '0xpartial' })] },
      }),
    );
    const result = v2.decodeAndPersist('base', '0xpartial');

    expect(result.status).toBe('unclassified');
    const rows = db.select().from(unclassified).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toContain('guard tripped');
    expect(eventCount(sqlite, 'base', '0xpartial')).toBe(0);
  });

  it('skipped txs write neither events nor unclassified rows', () => {
    const { db, sqlite } = createTestDb();
    insertRawTx(db, makeRawTx({ txHash: '0xspam' }));

    const registry = new DecoderRegistry(db);
    registry.registerHandler(makeHandler({ id: 'spam-filter', result: { kind: 'skip' } }));
    const result = registry.decodeAndPersist('base', '0xspam');

    expect(result.status).toBe('skipped');
    expect(eventCount(sqlite, 'base', '0xspam')).toBe(0);
    expect(db.select().from(unclassified).all()).toHaveLength(0);
  });
});
