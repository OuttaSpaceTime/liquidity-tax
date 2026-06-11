import { readFileSync } from 'node:fs';
import { events } from '../../db/schema';
import type { Db } from '../../src/db/client';

const FIXTURE_DIR = new URL('../fixtures/prices/', import.meta.url).pathname;

/** Recorded API fixture: `{ status, body }` as captured by capture.ts. */
export interface RecordedResponse {
  status: number;
  body: unknown;
}

export function loadFixture(name: string): RecordedResponse {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}${name}`, 'utf8')) as RecordedResponse;
}

export function fixturePath(name: string): string {
  return `${FIXTURE_DIR}${name}`;
}

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * fetch fake fed by a queue of recorded responses. Records every request.
 * Repeats the last response when the queue runs dry.
 */
export function fakeFetch(responses: readonly RecordedResponse[]) {
  const requests: RecordedRequest[] = [];
  let i = 0;
  const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    requests.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return Promise.resolve(
      new Response(JSON.stringify(rec.body), {
        status: rec.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetchFn: fetchFn as typeof fetch, requests };
}

/** sleep fake that records requested durations and resolves immediately. */
export function fakeSleep() {
  const sleeps: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  return { sleep, sleeps };
}

/** Insert a minimal decoded event carrying the given assets at the given time. */
export function insertEvent(
  db: Db,
  opts: {
    txHash: string;
    timestamp: number;
    sentAsset?: string;
    receivedAsset?: string;
    logIndex?: number;
  },
): void {
  db.insert(events)
    .values({
      chain: 'base',
      txHash: opts.txHash,
      logIndex: opts.logIndex ?? 0,
      emissionSeq: 0,
      timestamp: opts.timestamp,
      wallet: '0xwallet',
      type: 'swap',
      subtype: 'trade',
      sentAsset: opts.sentAsset,
      receivedAsset: opts.receivedAsset,
      handlerId: 'test_handler',
      handlerVersion: 1,
    })
    .run();
}
