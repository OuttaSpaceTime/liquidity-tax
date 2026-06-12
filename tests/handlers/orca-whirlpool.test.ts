import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flattenParsedTransaction } from '../../src/chains/solana/whirlpool-scan';
import { DecoderRegistry } from '../../src/decoder';
import type { RawTx } from '../../src/decoder/types';
import { orcaWhirlpoolHandler } from '../../src/handlers/orca-whirlpool';
import { groupEventsByPosition, reducePositionEvents } from '../../src/positions';
import type { TaxEvent } from '../../src/types/event';
import { createTestDb } from '../helpers/db';

/**
 * [1B.3] Orca Whirlpool handler tests, driven by the [1B.4] hand-labeled
 * golden fixtures (tests/fixtures/solana/whirlpool-golden.json). Unlike the
 * registry-level golden suite (tests/chains/solana/whirlpool-golden.test.ts,
 * which activates once the handler replaces its stub in
 * `createDefaultRegistry`), this suite registers the real handler directly so
 * it runs red-first regardless of foundation wiring.
 */

const FIXTURE_DIR = join(import.meta.dir, '../fixtures/solana');

interface GoldenExpectedEvent {
  type: TaxEvent['type'];
  subtype: TaxEvent['subtype'];
  logIndex: number;
  emissionSeq: number;
  timestamp: number;
  wallet: string;
  sentAsset?: string;
  sentAmount?: string;
  receivedAsset?: string;
  receivedAmount?: string;
  positionId?: TaxEvent['positionId'];
  flags?: TaxEvent['flags'];
}

interface GoldenFixture {
  txHash: string;
  source: 'own' | 'foreign';
  case: string;
  notes: string;
  wallet: string;
  expectedEvents: GoldenExpectedEvent[];
}

const golden = JSON.parse(readFileSync(join(FIXTURE_DIR, 'whirlpool-golden.json'), 'utf8')) as {
  fixtures: GoldenFixture[];
};

function loadRawTx(txHash: string): RawTx {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, 'raw', `${txHash}.json`), 'utf8')) as RawTx;
}

function makeRegistry(wallets: readonly string[]): DecoderRegistry {
  const { db } = createTestDb();
  const registry = new DecoderRegistry(db, { wallets: { solana: [...wallets] } });
  registry.registerHandler(orcaWhirlpoolHandler);
  return registry;
}

/** Full TaxEvent minus handler identity/versioning noise (same shape as the golden suite). */
function comparable(event: TaxEvent) {
  return {
    type: event.type,
    subtype: event.subtype,
    logIndex: event.logIndex,
    emissionSeq: event.emissionSeq,
    timestamp: event.timestamp,
    wallet: event.wallet,
    sentAsset: event.sentAsset,
    sentAmount: event.sentAmount,
    receivedAsset: event.receivedAsset,
    receivedAmount: event.receivedAmount,
    positionId: event.positionId,
    flags: event.flags,
  };
}

function expectedComparable(event: GoldenExpectedEvent) {
  return {
    type: event.type,
    subtype: event.subtype,
    logIndex: event.logIndex,
    emissionSeq: event.emissionSeq,
    timestamp: event.timestamp,
    wallet: event.wallet,
    sentAsset: event.sentAsset,
    sentAmount: event.sentAmount === undefined ? undefined : BigInt(event.sentAmount),
    receivedAsset: event.receivedAsset,
    receivedAmount: event.receivedAmount === undefined ? undefined : BigInt(event.receivedAmount),
    positionId: event.positionId,
    flags: event.flags,
  };
}

function decodeFixture(fixture: GoldenFixture): TaxEvent[] {
  const result = makeRegistry([fixture.wallet]).decode(loadRawTx(fixture.txHash));
  expect(result.status).toBe('decoded');
  return result.status === 'decoded' ? result.events : [];
}

describe('orca whirlpool handler [1B.3]', () => {
  it('matches every golden fixture tx', () => {
    for (const fixture of golden.fixtures) {
      expect(orcaWhirlpoolHandler.matches(loadRawTx(fixture.txHash))).toBe(true);
    }
  });

  it('is a real handler (version > 0, solana, id orca_whirlpool)', () => {
    expect(orcaWhirlpoolHandler.id).toBe('orca_whirlpool');
    expect(orcaWhirlpoolHandler.chain).toBe('solana');
    expect(orcaWhirlpoolHandler.version).toBeGreaterThan(0);
  });

  for (const [i, fixture] of golden.fixtures.entries()) {
    it(`#${i} ${fixture.case} (${fixture.source})`, () => {
      const events = decodeFixture(fixture);
      expect(events.map(comparable)).toEqual(fixture.expectedEvents.map(expectedComparable));
      for (const event of events) {
        expect(event.handlerId).toBe('orca_whirlpool');
        expect(event.chain).toBe('solana');
        expect(event.txHash).toBe(fixture.txHash);
      }
    });
  }

  it('skips a Whirlpool tx where no configured wallet is involved', () => {
    const fixture = golden.fixtures[0];
    const raw = loadRawTx(fixture.txHash);
    expect(orcaWhirlpoolHandler.matches(raw)).toBe(true);
    // Registry configured with an unrelated wallet (not among the tx's account keys) — tx is not ours.
    const result = makeRegistry(['Unre1atedWa11etPubkey111111111111111111111']).decode(raw);
    expect(result.status).toBe('skipped');
  });
});

describe('orca whirlpool — CPI nesting, failed txs, multi-hop residual (review regressions)', () => {
  interface MutableInnerIx {
    stackHeight?: number | null;
    programId?: string;
    parsed?: { type?: string; info?: { amount?: string; tokenAmount?: { amount?: string } } };
    [key: string]: unknown;
  }
  interface MutableRawJson {
    transaction: { message: { instructions: MutableInnerIx[] } };
    meta: {
      err: unknown;
      innerInstructions: Array<{ index: number; instructions: MutableInnerIx[] }>;
    };
  }

  it('propagates jsonParsed stackHeight into FlatInstruction.depth (real fixture carries stackHeight 3)', () => {
    // wYcczFGa…/yXtA5G68… contain stackHeight-3 inner instructions (token-account
    // creation under the openPositionWithTokenExtensions ATA-create) — they must
    // flatten to depth 2, not be collapsed onto depth 1.
    const raw = loadRawTx('yXtA5G68ZcUhbEsXxjjTgGDBbrMsSXRdxT6xrakH5fLmK2T64PP6GHisBymGmzBPukiXrUufYnHs9kLmUnZtmP5');
    const flat = flattenParsedTransaction(raw.rawJson);
    expect(flat.some((ix) => ix.depth === 2)).toBe(true);
  });

  it('decodes a Whirlpool harvest invoked via CPI (router-wrapped, stackHeight 2/3)', () => {
    // Synthetic nesting of the REAL fixture qvMYfEc4… (harvest: collectFees +
    // collectReward): the whole original instruction list becomes the inner
    // instructions of a fake aggregator router — the shape of a Jupiter-routed
    // or auto-compounder Whirlpool call. Every flat index shifts by +1.
    const fixture = golden.fixtures.find((f) => f.txHash.startsWith('qvMYfEc4'))!;
    const raw = loadRawTx(fixture.txHash);
    const rawJson = raw.rawJson as unknown as MutableRawJson;
    const innerByIndex = new Map(
      rawJson.meta.innerInstructions.map((entry) => [entry.index, entry.instructions]),
    );
    const nested: MutableInnerIx[] = [];
    rawJson.transaction.message.instructions.forEach((ix, index) => {
      nested.push({ ...ix, stackHeight: 2 });
      for (const child of innerByIndex.get(index) ?? []) {
        nested.push({ ...child, stackHeight: (child.stackHeight ?? 2) + 1 });
      }
    });
    rawJson.transaction.message.instructions = [
      { programId: 'RouterFake1111111111111111111111111111111111', accounts: [], data: '' },
    ];
    rawJson.meta.innerInstructions = [{ index: 0, instructions: nested }];

    const result = makeRegistry([fixture.wallet]).decode(raw);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') return;
    const expected = fixture.expectedEvents.map(expectedComparable).map((e) => ({
      ...e,
      logIndex: e.logIndex + 1,
    }));
    expect(result.events.map(comparable)).toEqual(expected);
  });

  it('emits NO protocol events for a failed (meta.err) Whirlpool tx', () => {
    // A slippage-failed open/close still lists the outer instructions but has
    // no inner instructions — lifecycle events must not fire.
    const fixture = golden.fixtures.find((f) => f.txHash.startsWith('yXtA5G68'))!;
    const raw = loadRawTx(fixture.txHash);
    const rawJson = raw.rawJson as unknown as MutableRawJson;
    rawJson.meta.err = { InstructionError: [2, { Custom: 6022 }] };
    rawJson.meta.innerInstructions = [];

    const result = makeRegistry([fixture.wallet]).decode(raw);
    expect(result.status).toBe('skipped');
  });

  it('routes a TwoHopSwap with an unequal intermediate to the manual queue instead of dropping the residual', () => {
    const fixture = golden.fixtures.find((f) => f.txHash.startsWith('r62RgUWJ'))!;
    const raw = loadRawTx(fixture.txHash);
    const rawJson = raw.rawJson as unknown as MutableRawJson;
    let bumped = 0;
    for (const entry of rawJson.meta.innerInstructions) {
      for (const ix of entry.instructions) {
        const info = ix.parsed?.info;
        if (info?.amount === '265484693' && bumped === 0) {
          info.amount = '265484694';
          bumped += 1;
        } else if (info?.tokenAmount?.amount === '265484693' && bumped === 0) {
          info.tokenAmount.amount = '265484694';
          bumped += 1;
        }
      }
    }
    expect(bumped).toBe(1);

    const result = makeRegistry([fixture.wallet]).decode(raw);
    expect(result.status).toBe('unclassified');
    if (result.status === 'unclassified') {
      expect(result.reason).toContain('nets to');
    }
  });
});

describe('orca whirlpool position tracker integration', () => {
  it('reduces fixtures #8 + #9 (same position: harvest, then decrease + close) to a closed snapshot', () => {
    // Fixture #8: two-position harvest; #9: single-sided decrease + close of
    // position 8eKMieua... 93s later — a cross-tx rebalance-style lifecycle.
    const events = [...decodeFixture(golden.fixtures[8]), ...decodeFixture(golden.fixtures[9])];
    const positionId = 'solana:orca_whirlpool:8eKMieuaZaybEDdPRyUDPzU1vSc7tyw27Mtufp9mMa5h';
    const groups = groupEventsByPosition(events);
    const snapshot = reducePositionEvents(positionId, groups.get(positionId) ?? []);

    expect(snapshot).toBeDefined();
    if (snapshot === undefined) return;
    expect(snapshot.chain).toBe('solana');
    expect(snapshot.protocol).toBe('orca_whirlpool');
    expect(snapshot.state.status).toBe('closed');
    expect(snapshot.closedAt).toBe(1763626749);
    // Open tx predates the fixture set — the reducer infers the open.
    expect(snapshot.state.inferredOpen).toBe(true);
    expect(snapshot.state.withdrawn).toEqual({
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: '5770558454',
    });
    expect(snapshot.state.feesCollected).toEqual({
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: '9969209',
      So11111111111111111111111111111111111111112: '58388605',
    });
  });

  it('every position-scoped event type reduces without unexpected-type warnings (fixtures #0 + #4)', () => {
    const events = [...decodeFixture(golden.fixtures[0]), ...decodeFixture(golden.fixtures[4])];
    for (const [positionId, group] of groupEventsByPosition(events)) {
      const snapshot = reducePositionEvents(positionId, group);
      expect(snapshot).toBeDefined();
      const warnings = snapshot?.state.warnings ?? [];
      expect(warnings.filter((w) => w.startsWith('unexpected_event_type'))).toEqual([]);
    }
  });
});

describe('orca whirlpool — token-2022 transfer-fee CPI legs (review regressions)', () => {
  interface MutableParsedIx {
    parsed?: {
      type?: string;
      info?: {
        tokenAmount?: { amount?: string; decimals?: number };
        feeAmount?: { amount?: string; decimals?: number };
        mint?: string;
      };
    };
    [key: string]: unknown;
  }
  interface MutableMeta {
    meta: { innerInstructions: Array<{ index: number; instructions: MutableParsedIx[] }> };
  }

  /** Rewrite the transferChecked leg moving `amount` into transferCheckedWithFee (fee withheld at destination). */
  function addTransferFee(raw: RawTx, amount: string, fee: string): void {
    let rewritten = 0;
    for (const entry of (raw.rawJson as unknown as MutableMeta).meta.innerInstructions) {
      for (const ix of entry.instructions) {
        const info = ix.parsed?.info;
        if (ix.parsed?.type === 'transferChecked' && info?.tokenAmount?.amount === amount) {
          ix.parsed.type = 'transferCheckedWithFee';
          info.feeAmount = { amount: fee, decimals: info.tokenAmount.decimals };
          rewritten += 1;
        }
      }
    }
    expect(rewritten).toBe(1);
  }

  it('credits the NET amount (gross − fee) for a collectFeesV2 leg on a transfer-fee mint', () => {
    // Variant of REAL fixture #5 (full close V2): the token-2022 hSOL fee leg
    // becomes a transferCheckedWithFee, as a transfer-fee-extension mint would
    // emit. The leg must not be silently skipped (review finding), and the
    // income at receipt is what actually arrives: gross − withheld fee.
    const fixture = golden.fixtures.find((f) => f.txHash.startsWith('2ETDRYW'))!;
    const raw = loadRawTx(fixture.txHash);
    addTransferFee(raw, '821263105', '1263105');

    const result = makeRegistry([fixture.wallet]).decode(raw);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') return;
    const expected = fixture.expectedEvents.map(expectedComparable).map((e) =>
      e.type === 'lp_fee' && e.receivedAmount === 821263105n
        ? { ...e, receivedAmount: 821263105n - 1263105n }
        : e,
    );
    expect(result.events.map(comparable)).toEqual(expected);
  });

  it('debits the GROSS amount for an increaseLiquidityV2 deposit leg on a transfer-fee mint', () => {
    // Variant of REAL fixture #1 (open + increaseV2 single-sided): the wallet
    // is debited the gross amount; the fee is withheld on the vault side.
    const fixture = golden.fixtures.find((f) => f.txHash.startsWith('wYcczFGa'))!;
    const raw = loadRawTx(fixture.txHash);
    addTransferFee(raw, '2660524176533', '24176533');

    const result = makeRegistry([fixture.wallet]).decode(raw);
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') return;
    expect(result.events.map(comparable)).toEqual(fixture.expectedEvents.map(expectedComparable));
  });

  it('routes a liquidity instruction with ZERO transfer CPI legs to the manual queue, never a silent no-emit', () => {
    // Review finding: legacy payloads (stackHeight null) can flatten CPI legs
    // to the wrong depth, leaving increase/decrease/collect with zero legs —
    // a real one always CPIs at least one token transfer (zero-amount
    // included). Variant of REAL fixture #2 with the increase's inner
    // instruction group removed.
    const fixture = golden.fixtures.find((f) => f.txHash.startsWith('zhDAa6'))!;
    const raw = loadRawTx(fixture.txHash);
    const meta = (raw.rawJson as unknown as MutableMeta).meta;
    const before = meta.innerInstructions.length;
    meta.innerInstructions = meta.innerInstructions.filter((entry) => entry.index !== 5);
    expect(meta.innerInstructions.length).toBe(before - 1);

    const result = makeRegistry([fixture.wallet]).decode(raw);
    expect(result.status).toBe('unclassified');
    if (result.status === 'unclassified') {
      expect(result.reason).toContain('IncreaseLiquidity');
    }
  });
});
