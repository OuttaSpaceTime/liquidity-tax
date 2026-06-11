import type { DecodeContext, DecodeResult, Handler, RawTx } from '../decoder/types';
import type { Flag, TaxEvent } from '../types/event';
import {
  SUILEND_EVENT_TYPES,
  SUILEND_EVENT_TYPE_SUFFIXES,
  SUILEND_PACKAGE_ORIGINAL,
  type SuilendBorrowEvent,
  type SuilendClaimRewardEvent,
  type SuilendDepositEvent,
  type SuilendLiquidateEvent,
  type SuilendMintEvent,
  type SuilendRedeemEvent,
  type SuilendRepayEvent,
  type SuilendReserveAssetDataEvent,
  type SuilendTypeName,
  type SuilendWithdrawEvent,
} from '../types/suilend-events';

/**
 * [1C.5] Suilend phase-1 handler.
 *
 * Decodes all 13 Suilend Move event types ([1C.1] enumeration in
 * src/types/suilend-events.ts, verified against the published Move source
 * `onchain/suilend/contracts/suilend/sources/{lending_market,obligation,
 * reserve}.move`). Sui has no per-log claiming like the EVM path — the whole
 * tx is one ProgrammableTransactionBlock and `logIndex` is the position in
 * the `events` array of the SuiTransactionBlockResponse stored by [1C.2].
 *
 * Event → TaxEvent mapping (pinned by the [1C.6] golden fixtures under
 * tests/fixtures/sui/suilend-* and cross-01):
 *
 * - BorrowEvent  → lend_borrow:borrow  (received = liquidity_amount minus
 *   origination_fee_amount — the fee never reaches the wallet).
 * - RepayEvent   → lend_borrow:repay   (sent = liquidity_amount).
 * - ClaimRewardEvent (amount > 0) → lend_reward:claim. Zero-amount claims
 *   emit nothing (suilend-01 pins this).
 * - MintEvent + DepositEvent (same coin, equal ctoken amounts) → ONE
 *   lend_supply:deposit at the DepositEvent index whose sent amount is the
 *   MintEvent's UNDERLYING liquidity_amount, never the ctoken amount
 *   (ctoken ↔ underlying caveat in suilend-events.ts). When the minted
 *   amount equals a preceding same-coin ClaimRewardEvent the deposit is the
 *   `claim_rewards_and_deposit` compounding entry point and gets the
 *   `auto_compounded` flag.
 * - WithdrawEvent + RedeemEvent (same coin, equal ctoken amounts) → ONE
 *   lend_supply:withdraw at the RedeemEvent index, received = the redeemed
 *   UNDERLYING liquidity_amount. Standalone Mint/Redeem (no obligation leg)
 *   emit the same deposit/withdraw rows at their own index; standalone
 *   Deposit/Withdraw (wallet-held ctokens) convert ctokens → underlying via
 *   the same-tx ReserveAssetDataEvent exchange rate.
 * - LiquidateEvent → liquidator's perspective ONLY (two rows at the
 *   LiquidateEvent index, mirroring the navi-02 convention):
 *   liquidation:collateral_seized (seq 0, received = seized collateral; the
 *   same-tx RedeemEvent of the net `withdraw_amount - protocol_fee_amount`
 *   ctokens folds into this row instead of emitting a separate withdraw) and
 *   liquidation:debt_repaid (seq 1, sent = repay_amount).
 *   LIMITATION: the event carries only `obligation_id`, never the obligation
 *   owner's wallet, so the liquidated-user side cannot be attributed by a
 *   stateless handler — and such a tx is never ingested for the victim
 *   anyway (sender + fund recipient are both the bot). Attributing own
 *   liquidations needs the Phase-1D obligation_id → wallet map built from
 *   own Deposit/Borrow history (follow-up noted in the [1C.5] report).
 * - ForgiveEvent → no TaxEvent (protocol-side bad-debt write-off, not an
 *   own-wallet flow).
 * - InterestUpdateEvent / ReserveAssetDataEvent / ObligationDataEvent /
 *   ClaimStakingRewardsEvent → bookkeeping, no TaxEvent.
 *   ReserveAssetDataEvent additionally feeds the ctoken exchange rate:
 *   underlying = ctokens * supply_amount.value / (ctoken_supply * 1e18)
 *   (supply_amount is a 1e18 fixed-point suilend::decimal::Decimal; verified
 *   exact against the suilend-02 Redeem: 969991680 ctokens → 1000000088 SUI).
 *
 * Cross-protocol swap legs: Suilend positions are routinely managed through
 * aggregator PTBs (cross-01: claim → 7K router LST redemption; suilend-03:
 * flash-swap → repay). The aggregator SUMMARY events (7K
 * `router::SwapEvent`/`ConfirmSwapEvent`, `settle::Swap`) decode to ONE
 * swap:trade here under the dominant-protocol convention the fixtures pin
 * (mirroring the Sickle/Aerodrome proxy precedent on Base); per-pool leg
 * events (Cetus/Bluefin/Momentum/FlowX) are ignored. If a generic Sui swap
 * rule lands later, move AGGREGATOR_* there and re-label the fixtures
 * deliberately.
 */

const HANDLER_ID = 'suilend';
const HANDLER_VERSION = 1;

const SUILEND_EVENT_PREFIX = `${SUILEND_PACKAGE_ORIGINAL}::`;

/** 7K aggregator router (defining ID observed in cross-01). */
const SEVEN_K_PACKAGE = '0x33ec64e9bb369bf045ddc198c81adbf2acab424da37465d95296ee02045d2b17';
const SEVEN_K_SWAP = `${SEVEN_K_PACKAGE}::router::SwapEvent`;
const SEVEN_K_CONFIRM_SWAP = `${SEVEN_K_PACKAGE}::router::ConfirmSwapEvent`;
/** Aggregator settlement summary (defining ID observed in suilend-03). */
const AGGREGATOR_SETTLE_SWAP =
  '0xe8f996ea6ff38c557c253d3b93cfe2ebf393816487266786371aa4532a9229f2::settle::Swap';

/**
 * Coin type (TypeName.name, no 0x prefix) → symbol, for the fixture/report
 * asset naming convention (symbols, not type strings — matches
 * `uni-v3-like-base.ts` BASE_TOKEN_SYMBOLS). Verified via suix_getCoinMetadata
 * during fixture capture. Unknown types fall back to the 0x-prefixed type.
 */
const SUI_COIN_SYMBOLS: Readonly<Record<string, string>> = {
  '0000000000000000000000000000000000000000000000000000000000000002::sui::SUI': 'SUI',
  '83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI':
    'sSUI',
  'dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC': 'USDC',
  '375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT': 'USDT',
  'deeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP': 'DEEP',
  '356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL': 'WAL',
  // Wormhole-wrapped SOL (8 dec) — Suilend wSOL reserve.
  'b7844e289a8410e50fb3ca48d69eb9cf29e27d223ef90353fe1bd8e27ff8f3f8::coin::COIN': 'SOL',
};

function assetSymbol(coinType: SuilendTypeName): string {
  return SUI_COIN_SYMBOLS[coinType.name] ?? `0x${coinType.name}`;
}

/** One entry of SuiTransactionBlockResponse.events. */
interface SuiEventShape {
  type?: string;
  parsedJson?: unknown;
}

interface SuiRawJsonShape {
  transaction?: { data?: { sender?: string } } | null;
  events?: readonly SuiEventShape[] | null;
}

/** 7K router::SwapEvent / router::ConfirmSwapEvent payload (cross-01). */
interface SevenKSwapPayload {
  amount_in: string;
  amount_out: string;
  from: SuilendTypeName;
  target: SuilendTypeName;
}

/** Aggregator settle::Swap payload (suilend-03). */
interface AggregatorSettlePayload {
  amount_in: string;
  amount_out: string;
  coin_in: SuilendTypeName;
  coin_out: SuilendTypeName;
}

interface PendingClaim {
  coin: string;
  amount: bigint;
}

interface PendingMint {
  index: number;
  coin: string;
  /** Underlying deposited into the reserve. */
  liquidity: bigint;
  ctokens: bigint;
  autoCompounded: boolean;
}

interface PendingWithdraw {
  index: number;
  coin: string;
  ctokens: bigint;
}

interface PendingLiquidation {
  index: number;
  repayCoin: SuilendTypeName;
  repayAmount: bigint;
  withdrawCoin: SuilendTypeName;
  /** Ctokens the liquidator actually receives (withdraw_amount - protocol_fee_amount). */
  netCtokens: bigint;
  /** Filled when the liquidator redeems the seized ctokens in the same tx. */
  collateralUnderlying?: bigint;
}

/** Latest reserve exchange-rate snapshot per coin type. */
interface ReserveRate {
  /** supply_amount as 1e18 fixed-point Decimal. */
  supplyWad: bigint;
  ctokenSupply: bigint;
}

/** Remove and return the first element matching `pred` (FIFO pairing). */
function takeFirst<T>(items: T[], pred: (item: T) => boolean): T | undefined {
  const i = items.findIndex(pred);
  if (i === -1) return undefined;
  return items.splice(i, 1)[0];
}

function isSuilendEventType(type: string): boolean {
  return (
    type.startsWith(SUILEND_EVENT_PREFIX) ||
    type.endsWith(SUILEND_EVENT_TYPE_SUFFIXES.claimStakingRewards)
  );
}

export const suilendHandler: Handler = {
  id: HANDLER_ID,
  version: HANDLER_VERSION,
  chain: 'sui',

  matches(raw: RawTx): boolean {
    const events = (raw.rawJson as SuiRawJsonShape | null)?.events ?? [];
    return events.some((e) => e.type !== undefined && isSuilendEventType(e.type));
  },

  decode(raw: RawTx, ctx: DecodeContext): DecodeResult {
    const rawJson = raw.rawJson as SuiRawJsonShape | null;
    const sender = rawJson?.transaction?.data?.sender;
    if (sender === undefined || !ctx.wallets.has(sender)) return { kind: 'skip' };
    const rawEvents = rawJson?.events ?? [];

    const out: TaxEvent[] = [];
    const emit = (
      partial: Pick<TaxEvent, 'type' | 'subtype' | 'logIndex'> & Partial<TaxEvent>,
    ): void => {
      out.push({
        emissionSeq: 0,
        chain: 'sui',
        txHash: raw.txHash,
        timestamp: raw.blockTimestamp,
        wallet: sender,
        handlerId: HANDLER_ID,
        handlerVersion: HANDLER_VERSION,
        ...partial,
      });
    };

    const pendingClaims: PendingClaim[] = [];
    const pendingMints: PendingMint[] = [];
    const pendingWithdraws: PendingWithdraw[] = [];
    const pendingLiquidations: PendingLiquidation[] = [];
    const rates = new Map<string, ReserveRate>();
    const sevenKSwaps: Array<{ index: number; payload: SevenKSwapPayload }> = [];
    let sevenKConfirm: SevenKSwapPayload | undefined;
    const settleSwaps: Array<{ index: number; payload: AggregatorSettlePayload }> = [];

    const problems: string[] = [];

    /**
     * ctokens → underlying via the reserve exchange rate. NO silent 1:1
     * fallback: the rate only grows over time, so assuming 1:1 understates
     * the underlying — a missing same-tx ReserveAssetDataEvent snapshot is a
     * problem (→ manual queue), not an approximation.
     */
    const toUnderlying = (ctokens: bigint, coin: string, context: string): bigint | undefined => {
      const rate = rates.get(coin);
      if (rate === undefined || rate.ctokenSupply === 0n) {
        problems.push(
          `${context}: no same-tx ReserveAssetDataEvent exchange rate for ${coin} — ` +
            'ctoken→underlying conversion needs manual labeling',
        );
        return undefined;
      }
      return (ctokens * rate.supplyWad) / (rate.ctokenSupply * 10n ** 18n);
    };

    for (const [index, rawEvent] of rawEvents.entries()) {
      const type = rawEvent.type;
      if (type === undefined) continue;

      switch (type) {
        case SUILEND_EVENT_TYPES.borrow: {
          const p = rawEvent.parsedJson as SuilendBorrowEvent;
          emit({
            type: 'lend_borrow',
            subtype: 'borrow',
            logIndex: index,
            receivedAsset: assetSymbol(p.coin_type),
            receivedAmount: BigInt(p.liquidity_amount) - BigInt(p.origination_fee_amount),
          });
          break;
        }

        case SUILEND_EVENT_TYPES.repay: {
          const p = rawEvent.parsedJson as SuilendRepayEvent;
          emit({
            type: 'lend_borrow',
            subtype: 'repay',
            logIndex: index,
            sentAsset: assetSymbol(p.coin_type),
            sentAmount: BigInt(p.liquidity_amount),
          });
          break;
        }

        case SUILEND_EVENT_TYPES.claimReward: {
          const p = rawEvent.parsedJson as SuilendClaimRewardEvent;
          const amount = BigInt(p.liquidity_amount);
          if (amount === 0n) break; // zero-amount claims emit nothing (suilend-01)
          emit({
            type: 'lend_reward',
            subtype: 'claim',
            logIndex: index,
            receivedAsset: assetSymbol(p.coin_type),
            receivedAmount: amount,
          });
          pendingClaims.push({ coin: p.coin_type.name, amount });
          break;
        }

        case SUILEND_EVENT_TYPES.mint: {
          const p = rawEvent.parsedJson as SuilendMintEvent;
          const liquidity = BigInt(p.liquidity_amount);
          const claim = takeFirst(
            pendingClaims,
            (c) => c.coin === p.coin_type.name && c.amount === liquidity,
          );
          pendingMints.push({
            index,
            coin: p.coin_type.name,
            liquidity,
            ctokens: BigInt(p.ctoken_amount),
            autoCompounded: claim !== undefined,
          });
          break;
        }

        case SUILEND_EVENT_TYPES.deposit: {
          const p = rawEvent.parsedJson as SuilendDepositEvent;
          const ctokens = BigInt(p.ctoken_amount);
          const mint = takeFirst(
            pendingMints,
            (m) => m.coin === p.coin_type.name && m.ctokens === ctokens,
          );
          const sentAmount =
            mint?.liquidity ?? toUnderlying(ctokens, p.coin_type.name, `DepositEvent[${index}]`);
          if (sentAmount === undefined) break; // problem pushed → unclassified below
          emit({
            type: 'lend_supply',
            subtype: 'deposit',
            logIndex: index,
            sentAsset: assetSymbol(p.coin_type),
            sentAmount,
            ...(mint?.autoCompounded === true ? { flags: ['auto_compounded'] as Flag[] } : {}),
          });
          break;
        }

        case SUILEND_EVENT_TYPES.withdraw: {
          const p = rawEvent.parsedJson as SuilendWithdrawEvent;
          pendingWithdraws.push({
            index,
            coin: p.coin_type.name,
            ctokens: BigInt(p.ctoken_amount),
          });
          break;
        }

        case SUILEND_EVENT_TYPES.redeem: {
          const p = rawEvent.parsedJson as SuilendRedeemEvent;
          const ctokens = BigInt(p.ctoken_amount);
          const liquidity = BigInt(p.liquidity_amount);
          const liquidation = takeFirst(
            pendingLiquidations,
            (l) =>
              l.withdrawCoin.name === p.coin_type.name &&
              l.netCtokens === ctokens &&
              l.collateralUnderlying === undefined,
          );
          if (liquidation !== undefined) {
            // Seized-collateral redemption — folds into collateral_seized.
            liquidation.collateralUnderlying = liquidity;
            pendingLiquidations.push(liquidation);
            break;
          }
          takeFirst(pendingWithdraws, (w) => w.coin === p.coin_type.name && w.ctokens === ctokens);
          emit({
            type: 'lend_supply',
            subtype: 'withdraw',
            logIndex: index,
            receivedAsset: assetSymbol(p.coin_type),
            receivedAmount: liquidity,
          });
          break;
        }

        case SUILEND_EVENT_TYPES.liquidate: {
          const p = rawEvent.parsedJson as SuilendLiquidateEvent;
          pendingLiquidations.push({
            index,
            repayCoin: p.repay_coin_type,
            repayAmount: BigInt(p.repay_amount),
            withdrawCoin: p.withdraw_coin_type,
            netCtokens: BigInt(p.withdraw_amount) - BigInt(p.protocol_fee_amount),
          });
          break;
        }

        case SUILEND_EVENT_TYPES.reserveAssetData: {
          const p = rawEvent.parsedJson as SuilendReserveAssetDataEvent;
          rates.set(p.coin_type.name, {
            supplyWad: BigInt(p.supply_amount.value),
            ctokenSupply: BigInt(p.ctoken_supply),
          });
          break;
        }

        // Recognized, deliberately no TaxEvent.
        case SUILEND_EVENT_TYPES.forgive:
        case SUILEND_EVENT_TYPES.obligationData:
        case SUILEND_EVENT_TYPES.interestUpdate:
          break;

        case SEVEN_K_SWAP:
          sevenKSwaps.push({ index, payload: rawEvent.parsedJson as SevenKSwapPayload });
          break;

        case SEVEN_K_CONFIRM_SWAP:
          sevenKConfirm = rawEvent.parsedJson as SevenKSwapPayload;
          break;

        case AGGREGATOR_SETTLE_SWAP:
          settleSwaps.push({ index, payload: rawEvent.parsedJson as AggregatorSettlePayload });
          break;

        default:
          if (type.endsWith(SUILEND_EVENT_TYPE_SUFFIXES.claimStakingRewards)) break;
          // Other protocols' events (per-pool swap legs, oracle updates, ...)
          // are not this handler's responsibility.
          break;
      }
    }

    // Aggregator route totals — ONE swap:trade per route. A single route can
    // emit BOTH the settle::Swap summary and the 7K router::SwapEvent mirror
    // (and other handlers in the same registry face the same pair), so route
    // summaries deduplicate by (amount_in, amount_out), not by event index.
    const emittedTrades: Array<{ sent: bigint; received: bigint }> = [];
    const emitTrade = (
      logIndex: number,
      sentAsset: string,
      sent: bigint,
      receivedAsset: string,
      received: bigint,
    ): void => {
      if (emittedTrades.some((t) => t.sent === sent && t.received === received)) return;
      emittedTrades.push({ sent, received });
      emit({
        type: 'swap',
        subtype: 'trade',
        logIndex,
        sentAsset,
        sentAmount: sent,
        receivedAsset,
        receivedAmount: received,
      });
    };
    // settle::Swap summaries at their own index (suilend-03).
    for (const settle of settleSwaps) {
      emitTrade(
        settle.index,
        assetSymbol(settle.payload.coin_in),
        BigInt(settle.payload.amount_in),
        assetSymbol(settle.payload.coin_out),
        BigInt(settle.payload.amount_out),
      );
    }
    // 7K router: totals from ConfirmSwapEvent (multi-hop SwapEvents are
    // partial routes), pinned to the first SwapEvent's index (cross-01).
    const firstSevenK = sevenKSwaps[0];
    if (firstSevenK !== undefined) {
      const totals = sevenKConfirm ?? firstSevenK.payload;
      emitTrade(
        firstSevenK.index,
        assetSymbol(totals.from),
        BigInt(totals.amount_in),
        assetSymbol(totals.target),
        BigInt(totals.amount_out),
      );
    }

    // Standalone mints (underlying → wallet-held ctokens, no obligation leg).
    for (const mint of pendingMints) {
      emit({
        type: 'lend_supply',
        subtype: 'deposit',
        logIndex: mint.index,
        sentAsset: assetSymbol({ name: mint.coin }),
        sentAmount: mint.liquidity,
        ...(mint.autoCompounded ? { flags: ['auto_compounded'] as Flag[] } : {}),
      });
    }

    // Standalone withdraws (ctokens left the obligation but were not redeemed).
    for (const withdraw of pendingWithdraws) {
      const receivedAmount = toUnderlying(
        withdraw.ctokens,
        withdraw.coin,
        `WithdrawEvent[${withdraw.index}]`,
      );
      if (receivedAmount === undefined) continue;
      emit({
        type: 'lend_supply',
        subtype: 'withdraw',
        logIndex: withdraw.index,
        receivedAsset: assetSymbol({ name: withdraw.coin }),
        receivedAmount,
      });
    }

    // Liquidations (liquidator's perspective — see header).
    for (const liq of pendingLiquidations) {
      const seized =
        liq.collateralUnderlying ??
        toUnderlying(liq.netCtokens, liq.withdrawCoin.name, `LiquidateEvent[${liq.index}]`);
      if (seized !== undefined) {
        emit({
          type: 'liquidation',
          subtype: 'collateral_seized',
          logIndex: liq.index,
          emissionSeq: 0,
          receivedAsset: assetSymbol(liq.withdrawCoin),
          receivedAmount: seized,
        });
        emit({
          type: 'liquidation',
          subtype: 'debt_repaid',
          logIndex: liq.index,
          emissionSeq: 1,
          sentAsset: assetSymbol(liq.repayCoin),
          sentAmount: liq.repayAmount,
        });
      }
    }

    // Partial decodes must not silently understate taxable activity.
    if (problems.length > 0) return { kind: 'unclassified', reason: problems.join('; ') };
    if (out.length === 0) return { kind: 'skip' };
    return { kind: 'ok', events: out };
  },
};
