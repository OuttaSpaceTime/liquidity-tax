import {
  identifyWhirlpoolInstruction,
  WHIRLPOOL_PROGRAM_ADDRESS,
  WhirlpoolInstruction,
} from '@orca-so/whirlpools-client';
import { getBase58Encoder } from '@solana/kit';

/**
 * Whirlpool tx scanner — fixture-selection aid for [1B.4] and a reusable
 * classification primitive for the [1B.3] handler.
 *
 * Instruction identity comes from the Codama-generated
 * `identifyWhirlpoolInstruction` (8-byte Anchor discriminators) in
 * `@orca-so/whirlpools-client` — never hand-rolled (repo-analysis kit.md
 * §"Instruction & Account Decoding": reuse SDK codecs).
 *
 * CPI flattening mirrors `flattenTransactionResponse` from
 * `onchain/solana-tx-parser-public/src/helpers.ts`: outer instruction i is
 * followed by its `meta.innerInstructions[index === i]` list, producing one
 * ordered sequence. The zero-based position in that sequence is the
 * `logIndex` convention for Solana TaxEvents.
 */

const BASE58 = getBase58Encoder();

/** One instruction in flattened (outer + CPI, jsonParsed) order. */
export interface FlatInstruction {
  /** Zero-based index in the flattened sequence — the Solana `logIndex` convention. */
  flatIndex: number;
  /**
   * 0 = outer; inner instructions = `stackHeight - 1` (jsonParsed inner
   * instructions carry `stackHeight` starting at 2; deeper CPI levels — e.g.
   * a Whirlpool ix invoked by a router, or a token-2022 transfer-hook's
   * internal transfer — carry 3+). Defaults to depth 1 when absent (legacy
   * payloads without stackHeight).
   */
  depth: number;
  programId: string;
  /** Base58 instruction data (absent on RPC-parsed instructions). */
  data?: string;
  accounts?: readonly string[];
  /** RPC-parsed payload for natively parsed programs (spl-token, system, ...). */
  parsed?: unknown;
  program?: string;
}

interface JsonParsedInstruction {
  programId?: string;
  data?: string;
  accounts?: readonly string[];
  parsed?: unknown;
  program?: string;
  /** CPI nesting level of inner instructions (2 = direct child of the outer ix). */
  stackHeight?: number | null;
}

interface JsonParsedTxShape {
  meta?: {
    innerInstructions?: ReadonlyArray<{
      index: number;
      instructions: readonly JsonParsedInstruction[];
    }>;
  } | null;
  transaction?: {
    message?: { instructions?: readonly JsonParsedInstruction[] };
  };
}

/** Flatten a jsonParsed tx: outer ix, then its inner (CPI) ixs, in order. */
export function flattenParsedTransaction(raw: unknown): FlatInstruction[] {
  const tx = raw as JsonParsedTxShape;
  const outer = tx.transaction?.message?.instructions ?? [];
  const innerByIndex = new Map<number, readonly JsonParsedInstruction[]>(
    (tx.meta?.innerInstructions ?? []).map((entry) => [entry.index, entry.instructions]),
  );

  const flat: FlatInstruction[] = [];
  const push = (ix: JsonParsedInstruction, depth: number): void => {
    flat.push({
      flatIndex: flat.length,
      depth,
      programId: ix.programId ?? '',
      data: ix.data,
      accounts: ix.accounts,
      parsed: ix.parsed,
      program: ix.program,
    });
  };
  outer.forEach((ix, index) => {
    push(ix, 0);
    for (const inner of innerByIndex.get(index) ?? []) push(inner, (inner.stackHeight ?? 2) - 1);
  });
  return flat;
}

export interface WhirlpoolIxRef {
  flatIndex: number;
  depth: number;
  name: string;
  accounts: readonly string[];
}

/** All Whirlpool-program instructions (outer or CPI) of a jsonParsed tx, identified by name. */
export function findWhirlpoolInstructions(raw: unknown): WhirlpoolIxRef[] {
  const refs: WhirlpoolIxRef[] = [];
  for (const ix of flattenParsedTransaction(raw)) {
    if (ix.programId !== WHIRLPOOL_PROGRAM_ADDRESS || ix.data === undefined) continue;
    let name: string;
    try {
      const discriminated = identifyWhirlpoolInstruction(BASE58.encode(ix.data));
      name = WhirlpoolInstruction[discriminated];
    } catch {
      name = 'unknown';
    }
    refs.push({ flatIndex: ix.flatIndex, depth: ix.depth, name, accounts: ix.accounts ?? [] });
  }
  return refs;
}

/** CLI entry: scan raw_txs (chain=solana) and summarize Whirlpool activity. */
async function main(): Promise<void> {
  const { openDb } = await import('../../db/client');
  const { rawTxs } = await import('../../../db/schema');
  const { eq } = await import('drizzle-orm');

  const client = openDb();
  try {
    const rows = client.db.select().from(rawTxs).where(eq(rawTxs.chain, 'solana')).all();
    const histogram = new Map<string, number>();
    let whirlpoolTxs = 0;
    for (const row of rows) {
      const refs = findWhirlpoolInstructions(row.rawJson);
      if (refs.length === 0) continue;
      whirlpoolTxs += 1;
      const names = refs.map((r) => `${r.name}@${r.flatIndex}${r.depth > 0 ? '(cpi)' : ''}`);
      const day = new Date(row.blockTimestamp * 1000).toISOString().slice(0, 10);
      console.log(`${row.txHash}  ${day}  ${names.join(' ')}`);
      for (const ref of refs) histogram.set(ref.name, (histogram.get(ref.name) ?? 0) + 1);
    }
    console.log(`\n${rows.length} solana txs, ${whirlpoolTxs} touch Whirlpool`);
    for (const [name, count] of [...histogram.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${name.padEnd(36)} ${count}`);
    }
  } finally {
    client.close();
  }
}

if (import.meta.main) await main();
