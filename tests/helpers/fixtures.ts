import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BaseRawJson } from '../../src/chains/base/raw-json';
import type { RawTx } from '../../src/decoder/types';
import type { TaxEvent } from '../../src/types/event';

/**
 * Shared golden-fixture loading for the per-handler and per-chain test
 * suites — the one place the fixture JSON contract lives (previously
 * re-declared in nine test files).
 *
 * Fixture conventions:
 * - Each fixture is a REAL on-chain tx (raw payload exactly as ingested) with
 *   a hand-labeled `expectedEvents: TaxEvent[]`, committed BEFORE the handler
 *   existed (locked test-first rule).
 * - `foreign: true` marks txs from other users (case absent from own history).
 * - Amounts are decimal strings (JSON has no bigint); revived via BigInt().
 * - `expectedEvents` omit `handlerVersion` (handlers version independently);
 *   every other TaxEvent field present in the fixture must match exactly.
 * - Asset naming: token symbol (WETH, USDC, SUI, haSUI, ...) — matches the
 *   positions/eur-price conventions.
 */

export type FixtureEvent = Omit<
  TaxEvent,
  'sentAmount' | 'receivedAmount' | 'handlerVersion' | 'priceUsd'
> & {
  sentAmount?: string;
  receivedAmount?: string;
};

export interface BaseFixture {
  chain: 'base';
  protocol: string;
  txHash: string;
  /** true = real on-chain tx from another user (case absent from own history). */
  foreign: boolean;
  notes: string;
  /** Addresses for DecodeContext.wallets (owner side of this tx). */
  walletsContext: string[];
  blockNumber: number;
  raw: BaseRawJson;
  /** Expected decode outcome; defaults to 'decoded'. 'skipped' = ours but deliberately no events (e.g. gauge NFT stake). */
  expectedStatus?: 'decoded' | 'skipped';
  expectedEvents: FixtureEvent[];
}

export interface SuiFixture {
  chain: 'sui';
  /** Primary protocol; cross-protocol PTBs list the dominant one. */
  protocol: string;
  /** [1C.6] scenario tag, e.g. lst_loop | navi_liquidation | turbos_rebalance. */
  scenario: string;
  txHash: string;
  /** true = real on-chain tx from another user (case absent from own history). */
  foreign: boolean;
  notes: string;
  /** Addresses for DecodeContext.wallets (owner side of this tx). */
  walletsContext: string[];
  blockNumber: number;
  /** Full SuiTransactionBlockResponse exactly as stored in raw_txs.raw_json. */
  raw: { timestampMs?: string | null } & Record<string, unknown>;
  /**
   * Expected decode outcome; defaults to 'decoded'. 'unclassified' = the tx
   * carries taxable legs no handler decodes yet (e.g. a foreign-protocol swap
   * inside an owned PTB, navi-04) — manual queue, never a silent partial decode.
   */
  expectedStatus?: 'decoded' | 'unclassified';
  expectedEvents: FixtureEvent[];
}

export const BASE_FIXTURES_DIR = join(import.meta.dir, '../fixtures/base');
export const SUI_FIXTURES_DIR = join(import.meta.dir, '../fixtures/sui');

/** Sorted fixture file names in `dir`, optionally restricted to a protocol prefix. */
export function listFixtureFiles(dir: string, prefix?: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && (prefix === undefined || f.startsWith(prefix)))
    .sort();
}

export function loadBaseFixture(file: string): BaseFixture {
  return JSON.parse(readFileSync(join(BASE_FIXTURES_DIR, file), 'utf8')) as BaseFixture;
}

export function loadSuiFixture(file: string): SuiFixture {
  return JSON.parse(readFileSync(join(SUI_FIXTURES_DIR, file), 'utf8')) as SuiFixture;
}

/** The raw_txs row a Sui fixture represents (timestampMs → unix seconds). */
export function suiFixtureToRawTx(fixture: SuiFixture): RawTx {
  return {
    chain: 'sui',
    txHash: fixture.txHash,
    blockNumber: fixture.blockNumber,
    blockTimestamp: Math.floor(Number(fixture.raw.timestampMs ?? 0) / 1000),
    rawJson: fixture.raw,
    fetchedAt: 0,
  };
}
