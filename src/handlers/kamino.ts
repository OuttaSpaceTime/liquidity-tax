import { getBase58Encoder } from '@solana/kit';
import { flattenParsedTransaction, type FlatInstruction } from '../chains/solana/whirlpool-scan';
import type { DecodeContext, DecodeResult, Handler, RawTx } from '../decoder/types';
import type { TaxEvent } from '../types/event';

/**
 * Kamino Lend (KLend) phase-1 handler (Solana, WS3).
 *
 * Kamino is an Anchor program with no Codama/SDK client to reuse, so
 * instructions are identified by their 8-byte Anchor discriminator
 * (`sha256("global:<snake_name>")[:8]`, verified against the real receipts in
 * `tests/fixtures/solana/kamino-*`), then paired with the adjacent SPL
 * transfer CPI leg for the actual amount + mint — the same instruction-level
 * dispatch the orca-whirlpool handler uses. The logs only carry
 * `RefreshReserve`/`RefreshObligation` plumbing names, so amounts are NEVER
 * taken from log text.
 *
 * Mapping (V1 + V2 share a role):
 *   deposit_reserve_liquidity_and_obligation_collateral  → lend_supply:deposit (sent)
 *   withdraw_obligation_collateral_and_redeem_reserve_…  → lend_supply:withdraw (received)
 *   borrow_obligation_liquidity                          → lend_borrow:borrow (received)
 *   repay_obligation_liquidity                           → lend_borrow:repay (sent)
 *
 * Leveraged loops (Kamino "Multiply"/manual leverage) wrap the lending legs in
 * `flash_borrow`/`flash_repay_reserve_liquidity` plus embedded DEX swaps. Those
 * swaps are taxable disposals with no Solana swap handler yet, so a flash-loan
 * tx goes to the manual queue WHOLE rather than emitting a lending-only partial
 * decode that silently drops the swaps.
 *
 * Native SOL collateral is wrapped in-tx through an ephemeral wSOL ATA (created
 * + closed within the tx, absent from pre/post token balances), so the leg's
 * source/destination are not owner-owned; the amount + mint come straight from
 * the TransferChecked leg (which carries the wSOL mint), not from owner-side
 * attribution. Assets are raw mint addresses, matching the orca convention.
 *
 * lend_* events carry no positionId; the lending-position lifecycle
 * (src/positions/lending.ts) groups them by (chain, protocol, wallet).
 */

const HANDLER_ID = 'kamino';
const HANDLER_VERSION = 1;

/** Kamino Lend program (KLend) — mainnet. */
const KLEND_PROGRAM = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';

/** SPL Token + Token-2022 program ids (jsonParsed reports both as `program: 'spl-token'`). */
const TOKEN_PROGRAM_IDS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

const BASE58 = getBase58Encoder();

type LendRole = 'supply' | 'withdraw' | 'borrow' | 'repay' | 'flash';

/** Anchor discriminators (hex of the first 8 instruction-data bytes). */
const DISCRIMINATORS: Readonly<Record<string, LendRole>> = {
  '81c70402de271a2e': 'supply', //  deposit_reserve_liquidity_and_obligation_collateral
  d8e0bf1bcc9766af: 'supply', //    deposit_reserve_liquidity_and_obligation_collateral_v2
  '797f12cc49f5e141': 'borrow', //  borrow_obligation_liquidity
  a1808ff5abc7c206: 'borrow', //    borrow_obligation_liquidity_v2
  '91b20de14cf09348': 'repay', //   repay_obligation_liquidity
  '74aed54cb435d290': 'repay', //   repay_obligation_liquidity_v2
  '4b5d5ddc2296dac4': 'withdraw', // withdraw_obligation_collateral_and_redeem_reserve_collateral
  eb34779895c51407: 'withdraw', //  withdraw_obligation_collateral_and_redeem_reserve_collateral_v2
  '87e734a70734d4c1': 'flash', //   flash_borrow_reserve_liquidity
  b97500cb60f5b4ba: 'flash', //     flash_repay_reserve_liquidity
};

interface ParsedAccountKey {
  pubkey?: string;
  signer?: boolean;
}

interface TokenBalanceEntry {
  accountIndex?: number;
  mint?: string;
}

interface RawJsonShape {
  transaction?: { message?: { accountKeys?: readonly ParsedAccountKey[] } };
  meta?: {
    err?: unknown;
    preTokenBalances?: readonly TokenBalanceEntry[];
    postTokenBalances?: readonly TokenBalanceEntry[];
  } | null;
}

interface ParsedTransferInfoShape {
  amount?: string;
  tokenAmount?: { amount?: string };
  feeAmount?: { amount?: string };
  mint?: string;
  source?: string;
  destination?: string;
}

/** One SPL transfer/transferChecked[WithFee] CPI leg, mint-resolved. */
interface TransferLeg {
  mint: string;
  amount: bigint;
  fee: bigint;
}

/** Net amount arriving at the destination (gross − any token-2022 transfer fee). */
function legReceived(leg: TransferLeg): bigint {
  return leg.amount - leg.fee;
}

function accountKeys(raw: unknown): readonly ParsedAccountKey[] {
  return (raw as RawJsonShape).transaction?.message?.accountKeys ?? [];
}

/** Token account → mint, from pre+post token balances (V1 `transfer` legs carry no mint). */
function buildMintByAccount(raw: unknown): Map<string, string> {
  const shape = raw as RawJsonShape;
  const keys = accountKeys(raw);
  const map = new Map<string, string>();
  for (const list of [shape.meta?.preTokenBalances, shape.meta?.postTokenBalances]) {
    for (const entry of list ?? []) {
      if (entry.accountIndex === undefined || entry.mint === undefined) continue;
      const pubkey = keys[entry.accountIndex]?.pubkey;
      if (pubkey !== undefined) map.set(pubkey, entry.mint);
    }
  }
  return map;
}

/** First 8 instruction-data bytes as hex — the Anchor discriminator. */
function discriminatorHex(data: string): string {
  const bytes = BASE58.encode(data);
  let hex = '';
  for (let i = 0; i < 8 && i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return hex;
}

/** DIRECT CPI children (depth + 1) of a flattened instruction; grandchildren excluded. */
function cpiChildren(
  flat: readonly FlatInstruction[],
  parentFlatIndex: number,
  parentDepth: number,
): FlatInstruction[] {
  const children: FlatInstruction[] = [];
  for (let i = parentFlatIndex + 1; i < flat.length && flat[i]!.depth > parentDepth; i++) {
    if (flat[i]!.depth === parentDepth + 1) children.push(flat[i]!);
  }
  return children;
}

/** SPL transfer legs among an instruction's CPI children (mintTo/burn/closeAccount skipped). */
function transferLegs(
  children: readonly FlatInstruction[],
  mintByAccount: ReadonlyMap<string, string>,
): TransferLeg[] | string {
  const legs: TransferLeg[] = [];
  for (const child of children) {
    if (!TOKEN_PROGRAM_IDS.has(child.programId)) continue;
    const parsed = child.parsed as { type?: string; info?: ParsedTransferInfoShape } | undefined;
    const type = parsed?.type;
    if (type !== 'transfer' && type !== 'transferChecked' && type !== 'transferCheckedWithFee') {
      continue;
    }
    const info = parsed?.info ?? {};
    const amountRaw = type === 'transfer' ? info.amount : info.tokenAmount?.amount;
    const feeRaw = type === 'transferCheckedWithFee' ? info.feeAmount?.amount : '0';
    const mint = info.mint ?? mintByAccount.get(info.source ?? '') ?? mintByAccount.get(info.destination ?? '');
    if (amountRaw === undefined || feeRaw === undefined || mint === undefined) {
      return `unresolvable spl transfer leg at flat index ${child.flatIndex}`;
    }
    legs.push({ mint, amount: BigInt(amountRaw), fee: BigInt(feeRaw) });
  }
  return legs;
}

export const kaminoHandler: Handler = {
  id: HANDLER_ID,
  version: HANDLER_VERSION,
  chain: 'solana',

  /** Cheap check: KLend program among the tx's account keys. */
  matches(raw: RawTx): boolean {
    if (raw.chain !== 'solana') return false;
    return accountKeys(raw.rawJson).some((key) => key.pubkey === KLEND_PROGRAM);
  },

  decode(raw: RawTx, ctx: DecodeContext): DecodeResult {
    // Failed (reverted) txs keep their outer instructions but executed nothing.
    if (((raw.rawJson as RawJsonShape).meta?.err ?? null) !== null) return { kind: 'skip' };

    const keys = accountKeys(raw.rawJson);
    const wallet =
      keys.find((key) => key.signer === true && ctx.wallets.has(key.pubkey ?? ''))?.pubkey ??
      keys.find((key) => ctx.wallets.has(key.pubkey ?? ''))?.pubkey;
    // Kamino activity, but none of our wallets is involved — not ours.
    if (wallet === undefined) return { kind: 'skip' };

    const flat = flattenParsedTransaction(raw.rawJson);
    const lending: Array<{ flatIndex: number; depth: number; role: Exclude<LendRole, 'flash'> }> =
      [];
    let hasFlash = false;
    for (const ix of flat) {
      if (ix.programId !== KLEND_PROGRAM || ix.data === undefined) continue;
      const role = DISCRIMINATORS[discriminatorHex(ix.data)];
      if (role === undefined) continue; // Init/Refresh/SetStakeDelegated plumbing — no event
      if (role === 'flash') hasFlash = true;
      else lending.push({ flatIndex: ix.flatIndex, depth: ix.depth, role });
    }

    // Flash-loan leverage/loop: embedded DEX swaps are taxable but undecoded —
    // route the WHOLE tx to the manual queue, never a lending-only partial decode.
    if (hasFlash) {
      return {
        kind: 'unclassified',
        reason: `${HANDLER_ID}: Kamino flash-loan leverage/loop (embedded DEX swaps) — needs Solana swap+flashloan handling; label manually`,
      };
    }
    // Pure setup/refresh tx (InitObligation, InitUserMetadata, RefreshReserve…).
    if (lending.length === 0) return { kind: 'skip' };

    const mintByAccount = buildMintByAccount(raw.rawJson);
    const events: TaxEvent[] = [];
    const problems: string[] = [];
    const base = {
      chain: 'solana' as const,
      txHash: raw.txHash,
      timestamp: raw.blockTimestamp,
      wallet,
      handlerId: HANDLER_ID,
      handlerVersion: HANDLER_VERSION,
    };

    for (const { flatIndex, depth, role } of lending) {
      const legsOrError = transferLegs(cpiChildren(flat, flatIndex, depth), mintByAccount);
      if (typeof legsOrError === 'string') {
        problems.push(`${role} at flat index ${flatIndex}: ${legsOrError}`);
        continue;
      }
      const legs = legsOrError.filter((leg) => leg.amount > 0n);
      // A real supply/withdraw/borrow/repay moves exactly one underlying-liquidity
      // token. Anything else (cToken leg leaked in, zero legs) is surfaced.
      if (legs.length !== 1) {
        problems.push(
          `${role} at flat index ${flatIndex} expected exactly 1 underlying-liquidity SPL transfer leg, found ${legs.length}`,
        );
        continue;
      }
      const leg = legs[0]!;
      const at = { logIndex: flatIndex, emissionSeq: 0 };
      if (role === 'supply') {
        events.push({ ...base, ...at, type: 'lend_supply', subtype: 'deposit', sentAsset: leg.mint, sentAmount: leg.amount });
      } else if (role === 'repay') {
        events.push({ ...base, ...at, type: 'lend_borrow', subtype: 'repay', sentAsset: leg.mint, sentAmount: leg.amount });
      } else if (role === 'borrow') {
        events.push({ ...base, ...at, type: 'lend_borrow', subtype: 'borrow', receivedAsset: leg.mint, receivedAmount: legReceived(leg) });
      } else {
        events.push({ ...base, ...at, type: 'lend_supply', subtype: 'withdraw', receivedAsset: leg.mint, receivedAmount: legReceived(leg) });
      }
    }

    if (problems.length > 0) return { kind: 'unclassified', reason: `${HANDLER_ID}: ${problems.join('; ')}` };
    if (events.length === 0) return { kind: 'skip' };
    return { kind: 'ok', events };
  },
};
