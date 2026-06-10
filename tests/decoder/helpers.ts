import { rawTxs } from '../../db/schema';
import type { TestDb } from '../helpers/db';
import type { Chain, TaxEvent, TaxEventType } from '../../src/types/event';
import type { DecodeResult, Handler, RawTx } from '../../src/decoder/types';

/** Synthetic raw tx row. Infrastructure tests only — protocol handlers use real fixtures. */
export function makeRawTx(overrides: Partial<RawTx> = {}): RawTx {
  return {
    chain: 'base',
    txHash: '0xsynthetic01',
    blockNumber: 1_000_000,
    blockTimestamp: 1_700_000_000,
    rawJson: { synthetic: true },
    fetchedAt: 1_700_000_100,
    ...overrides,
  };
}

export function insertRawTx(db: TestDb['db'], raw: RawTx): void {
  db.insert(rawTxs).values(raw).run();
}

/** Synthetic TaxEvent with sane defaults; narrow via overrides. */
export function makeEvent(overrides: Partial<TaxEvent> & { handlerId: string }): TaxEvent {
  return {
    type: 'swap' as TaxEventType,
    subtype: 'trade',
    chain: 'base',
    txHash: '0xsynthetic01',
    logIndex: 0,
    emissionSeq: 0,
    timestamp: 1_700_000_000,
    wallet: '0xwallet',
    handlerVersion: 1,
    ...overrides,
  } as TaxEvent;
}

/** Synthetic handler whose matches/decode are injectable. */
export function makeHandler(opts: {
  id: string;
  chain?: Chain;
  version?: number;
  matches?: (raw: RawTx) => boolean;
  decode?: Handler['decode'];
  result?: DecodeResult;
}): Handler {
  return {
    id: opts.id,
    version: opts.version ?? 1,
    chain: opts.chain ?? 'base',
    matches: opts.matches ?? (() => true),
    decode: opts.decode ?? (() => opts.result ?? { kind: 'skip' }),
  };
}
