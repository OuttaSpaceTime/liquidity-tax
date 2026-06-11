import { WHIRLPOOL_PROGRAM_ADDRESS } from '@orca-so/whirlpools-client';
import {
  findWhirlpoolInstructions,
  flattenParsedTransaction,
  type FlatInstruction,
  type WhirlpoolIxRef,
} from '../chains/solana/whirlpool-scan';
import type { DecodeContext, DecodeResult, Handler, RawTx } from '../decoder/types';
import type { PositionId, TaxEvent } from '../types/event';

/**
 * [1B.3] Orca Whirlpool phase-1 handler.
 *
 * Classification follows the repo-analysis recipe
 * (`.claude/docs/repo-analysis/whirlpools.md` §"What stays custom"): identify
 * each Whirlpool-program instruction by its Codama discriminator (via
 * `findWhirlpoolInstructions`, which wraps `identifyWhirlpoolInstruction`
 * from `@orca-so/whirlpools-client`), then pair it with its adjacent SPL
 * `transfer`/`transferChecked` CPI children (depth + 1 in the flattened
 * jsonParsed sequence) to get the actual token amounts moved. Fee transfers
 * are disambiguated from `decreaseLiquidity` principal by instruction-level
 * dispatch: each leg belongs to exactly one parent Whirlpool instruction, so
 * a compound tx (decrease + collectFees + close, or collect-then-increase)
 * splits naturally.
 *
 * Event mapping, `logIndex`/`emissionSeq` conventions, the zero-amount-leg
 * skip rule and the position-PDA `positionId` are pinned by the [1B.4]
 * golden fixtures (`tests/fixtures/solana/whirlpool-golden.json`
 * `conventions` block). The position PDA — not the NFT mint — identifies the
 * position because it is the one account present in every lifecycle
 * instruction; the emitted `positionId` feeds the shared CLMM lifecycle
 * tracker (`src/positions/tracker.ts`) unchanged.
 */

const HANDLER_ID = 'orca_whirlpool';
const HANDLER_VERSION = 1;

/** SPL Token + Token-2022 program ids (jsonParsed reports both as `program: 'spl-token'`). */
const TOKEN_PROGRAM_IDS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

/**
 * Index of the `position` account per instruction, from the Codama-generated
 * `Parsed*Instruction` account layouts in `@orca-so/whirlpools-client`
 * (verified against `onchain/whirlpools/ts-sdk/client/src/generated/instructions/`).
 */
const POSITION_ACCOUNT_INDEX: Readonly<Record<string, number>> = {
  OpenPosition: 2,
  OpenPositionWithMetadata: 2,
  OpenPositionWithTokenExtensions: 2,
  IncreaseLiquidity: 3,
  IncreaseLiquidityV2: 5,
  DecreaseLiquidity: 3,
  DecreaseLiquidityV2: 5,
  CollectFees: 2,
  CollectFeesV2: 2,
  CollectReward: 2,
  CollectRewardV2: 2,
  ClosePosition: 2,
  ClosePositionWithTokenExtensions: 2,
};

/**
 * Pool token-vault account indexes per swap variant (same source as above).
 * A leg paying INTO a vault is the user's sent side; a leg paying OUT of a
 * vault is the received side — robust to exact-in/exact-out leg ordering.
 */
const SWAP_VAULT_INDEXES: Readonly<Record<string, readonly number[]>> = {
  Swap: [4, 6],
  SwapV2: [8, 10],
  TwoHopSwap: [5, 7, 9, 11],
  TwoHopSwapV2: [9, 10, 11, 12],
};

const OPEN_NAMES = new Set(Object.keys(POSITION_ACCOUNT_INDEX).filter((n) => n.startsWith('Open')));
const CLOSE_NAMES = new Set(['ClosePosition', 'ClosePositionWithTokenExtensions']);
const INCREASE_NAMES = new Set(['IncreaseLiquidity', 'IncreaseLiquidityV2']);
const DECREASE_NAMES = new Set(['DecreaseLiquidity', 'DecreaseLiquidityV2']);
const COLLECT_FEES_NAMES = new Set(['CollectFees', 'CollectFeesV2']);
const COLLECT_REWARD_NAMES = new Set(['CollectReward', 'CollectRewardV2']);

/** Pure state updates / plumbing that legitimately emit no tax event. */
const NOOP_NAMES = new Set(['UpdateFeesAndRewards', 'IdlInclude']);

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
    /** null on success; an error object on failed (reverted) txs. */
    err?: unknown;
    preTokenBalances?: readonly TokenBalanceEntry[];
    postTokenBalances?: readonly TokenBalanceEntry[];
  } | null;
}

/** One SPL transfer/transferChecked CPI leg, mint-resolved. */
interface TransferLeg {
  mint: string;
  amount: bigint;
  source: string;
  destination: string;
}

interface ParsedTransferInfoShape {
  amount?: string;
  tokenAmount?: { amount?: string };
  mint?: string;
  source?: string;
  destination?: string;
}

function accountKeys(raw: unknown): readonly ParsedAccountKey[] {
  return (raw as RawJsonShape).transaction?.message?.accountKeys ?? [];
}

/**
 * Token account → mint map from pre+post token balances. V1 `transfer` legs
 * carry no mint; this resolves them (golden-fixture convention
 * `v1TransferMintResolution`). Ephemeral in-tx accounts (created and closed
 * within the tx) appear in neither snapshot — their leg resolves via the
 * counterparty vault account instead.
 */
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

/**
 * DIRECT CPI children of a flattened instruction: the following instructions
 * exactly one level deeper, up to the next instruction at the same or
 * shallower depth. Grandchildren (e.g. a token-2022 transfer-hook's internal
 * SPL transfer at depth+2) are excluded — counting them would add phantom
 * principal/fee legs. Works at any nesting level, so a Whirlpool instruction
 * invoked via CPI (router/auto-compounder at depth ≥ 1) still finds its
 * transfer legs at depth+1.
 */
function cpiChildren(flat: readonly FlatInstruction[], ix: WhirlpoolIxRef): FlatInstruction[] {
  const children: FlatInstruction[] = [];
  for (let i = ix.flatIndex + 1; i < flat.length && flat[i].depth > ix.depth; i++) {
    if (flat[i].depth === ix.depth + 1) children.push(flat[i]);
  }
  return children;
}

/**
 * SPL transfer legs among an instruction's CPI children, in inner-transfer
 * order (token A before token B). Returns an error string when a V1 leg's
 * mint cannot be resolved.
 */
function transferLegs(
  children: readonly FlatInstruction[],
  mintByAccount: ReadonlyMap<string, string>,
): TransferLeg[] | string {
  const legs: TransferLeg[] = [];
  for (const child of children) {
    if (!TOKEN_PROGRAM_IDS.has(child.programId)) continue;
    const parsed = child.parsed as { type?: string; info?: ParsedTransferInfoShape } | undefined;
    if (parsed?.type !== 'transfer' && parsed?.type !== 'transferChecked') continue;
    const info = parsed.info ?? {};
    const amountRaw = parsed.type === 'transferChecked' ? info.tokenAmount?.amount : info.amount;
    const source = info.source ?? '';
    const destination = info.destination ?? '';
    const mint = info.mint ?? mintByAccount.get(source) ?? mintByAccount.get(destination);
    if (amountRaw === undefined || mint === undefined) {
      return `unresolvable spl transfer leg at flat index ${child.flatIndex}`;
    }
    legs.push({ mint, amount: BigInt(amountRaw), source, destination });
  }
  return legs;
}

function positionIdOf(ix: WhirlpoolIxRef): PositionId | undefined {
  const index = POSITION_ACCOUNT_INDEX[ix.name];
  const pda = index === undefined ? undefined : ix.accounts[index];
  return pda === undefined ? undefined : `solana:${HANDLER_ID}:${pda}`;
}

/** Net a swap's legs into one (sent, received) pair, dropping intermediate mints. */
function netSwapLegs(
  ix: WhirlpoolIxRef,
  legs: readonly TransferLeg[],
): { sent: [string, bigint]; received: [string, bigint] } | string {
  const vaultIndexes = SWAP_VAULT_INDEXES[ix.name] ?? [];
  const vaults = new Set(vaultIndexes.map((i) => ix.accounts[i]).filter((a) => a !== undefined));
  const sent = new Map<string, bigint>();
  const received = new Map<string, bigint>();
  for (const leg of legs) {
    if (vaults.has(leg.destination)) {
      sent.set(leg.mint, (sent.get(leg.mint) ?? 0n) + leg.amount);
    } else if (vaults.has(leg.source)) {
      received.set(leg.mint, (received.get(leg.mint) ?? 0n) + leg.amount);
    }
    // Legs touching no vault (e.g. token-2022 transfer-fee skims) are ignored.
  }
  // A mint on both sides is the multi-hop intermediate — net BY AMOUNT
  // (subtract the smaller side, keep the remainder): an unequal intermediate
  // (e.g. token-2022 transfer-fee mints) leaves a residual that must surface
  // as a 2-mint side below → manual queue, never silently dropped value.
  for (const mint of [...sent.keys()]) {
    const sentAmount = sent.get(mint)!;
    const receivedAmount = received.get(mint);
    if (receivedAmount === undefined) continue;
    if (sentAmount === receivedAmount) {
      sent.delete(mint);
      received.delete(mint);
    } else if (sentAmount > receivedAmount) {
      sent.set(mint, sentAmount - receivedAmount);
      received.delete(mint);
    } else {
      received.set(mint, receivedAmount - sentAmount);
      sent.delete(mint);
    }
  }
  if (sent.size !== 1 || received.size !== 1) {
    return `${ix.name} at flat index ${ix.flatIndex} nets to ${sent.size} sent / ${received.size} received mints (expected 1/1)`;
  }
  return { sent: [...sent.entries()][0], received: [...received.entries()][0] };
}

export const orcaWhirlpoolHandler: Handler = {
  id: HANDLER_ID,
  version: HANDLER_VERSION,
  chain: 'solana',

  /** Cheap check: Whirlpool program among the tx's account keys (jsonParsed includes lookup-table addresses). */
  matches(raw: RawTx): boolean {
    if (raw.chain !== 'solana') return false;
    return accountKeys(raw.rawJson).some((key) => key.pubkey === WHIRLPOOL_PROGRAM_ADDRESS);
  },

  decode(raw: RawTx, ctx: DecodeContext): DecodeResult {
    // Failed (reverted) txs keep their outer message instructions, so e.g. a
    // slippage-failed ClosePosition would otherwise still emit its lifecycle
    // event. Nothing executed — no protocol events. (The gas:fee event is
    // ingest-owned and correct either way: the fee IS paid on failure.)
    if (((raw.rawJson as RawJsonShape).meta?.err ?? null) !== null) return { kind: 'skip' };

    const refs = findWhirlpoolInstructions(raw.rawJson);
    if (refs.length === 0) return { kind: 'skip' };

    const keys = accountKeys(raw.rawJson);
    const wallet =
      keys.find((key) => key.signer === true && ctx.wallets.has(key.pubkey ?? ''))?.pubkey ??
      keys.find((key) => ctx.wallets.has(key.pubkey ?? ''))?.pubkey;
    // Whirlpool activity, but none of our wallets is involved — not ours.
    if (wallet === undefined) return { kind: 'skip' };

    const flat = flattenParsedTransaction(raw.rawJson);
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

    for (const ix of refs) {
      const legsOrError = transferLegs(cpiChildren(flat, ix), mintByAccount);
      if (typeof legsOrError === 'string') {
        problems.push(`${ix.name}: ${legsOrError}`);
        continue;
      }
      // Zero-amount legs are skipped and do not consume an emissionSeq ordinal.
      const legs = legsOrError.filter((leg) => leg.amount > 0n);
      const positionId = positionIdOf(ix);
      const at = { logIndex: ix.flatIndex, positionId };

      if (OPEN_NAMES.has(ix.name)) {
        // Lifecycle marker only — the position NFT mint and rent are not principal.
        events.push({
          ...base,
          ...at,
          type: 'lp_deposit',
          subtype: 'open_position',
          emissionSeq: 0,
        });
      } else if (CLOSE_NAMES.has(ix.name)) {
        // NFT burn + rent refund are not principal either.
        events.push({
          ...base,
          ...at,
          type: 'lp_withdraw',
          subtype: 'close_position',
          emissionSeq: 0,
        });
      } else if (INCREASE_NAMES.has(ix.name)) {
        legs.forEach((leg, seq) => {
          events.push({
            ...base,
            ...at,
            type: 'lp_deposit',
            subtype: 'add_liquidity',
            emissionSeq: seq,
            sentAsset: leg.mint,
            sentAmount: leg.amount,
          });
        });
      } else if (DECREASE_NAMES.has(ix.name)) {
        legs.forEach((leg, seq) => {
          events.push({
            ...base,
            ...at,
            type: 'lp_withdraw',
            subtype: 'remove_liquidity',
            emissionSeq: seq,
            receivedAsset: leg.mint,
            receivedAmount: leg.amount,
          });
        });
      } else if (COLLECT_FEES_NAMES.has(ix.name)) {
        legs.forEach((leg, seq) => {
          events.push({
            ...base,
            ...at,
            type: 'lp_fee',
            subtype: 'collect',
            emissionSeq: seq,
            receivedAsset: leg.mint,
            receivedAmount: leg.amount,
          });
        });
      } else if (COLLECT_REWARD_NAMES.has(ix.name)) {
        // Zero-amount reward transfers (emissions inactive) emit nothing.
        legs.forEach((leg, seq) => {
          events.push({
            ...base,
            ...at,
            type: 'lp_reward',
            subtype: 'emission_claim',
            emissionSeq: seq,
            receivedAsset: leg.mint,
            receivedAmount: leg.amount,
          });
        });
      } else if (ix.name in SWAP_VAULT_INDEXES) {
        const netted = netSwapLegs(ix, legs);
        if (typeof netted === 'string') {
          problems.push(netted);
          continue;
        }
        events.push({
          ...base,
          type: 'swap',
          subtype: 'trade',
          logIndex: ix.flatIndex,
          emissionSeq: 0,
          sentAsset: netted.sent[0],
          sentAmount: netted.sent[1],
          receivedAsset: netted.received[0],
          receivedAmount: netted.received[1],
        });
      } else if (!NOOP_NAMES.has(ix.name)) {
        problems.push(`unhandled whirlpool instruction '${ix.name}' at flat index ${ix.flatIndex}`);
      }
    }

    // Any unhandled/unresolvable instruction sends the whole tx to the manual
    // queue — partial decodes must not silently understate taxable activity.
    if (problems.length > 0) return { kind: 'unclassified', reason: problems.join('; ') };
    // Whirlpool activity with nothing taxable (e.g. zero-amount reward harvest).
    if (events.length === 0) return { kind: 'skip' };
    return { kind: 'ok', events };
  },
};
