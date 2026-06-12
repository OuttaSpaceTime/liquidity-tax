import type { BaseRawJson, RawRpcLog } from '../chains/base/ingest';
import type { DecodeContext, DecodeResult, Handler, RawTx } from '../decoder/types';
import type { Chain, TaxEvent } from '../types/event';
import { BASE_TOKEN_SYMBOLS, topicAddress } from './uni-v3-like-base';

/**
 * Morpho handler for Base (task M1). Covers the three Morpho surfaces:
 *
 *  1. **Morpho Blue singleton** (0xBBBB…FFCb) market events, signatures
 *     hand-verified against real Base receipts in
 *     `tests/fixtures/base/morpho-*.json` (rotki's morpho decoder only covers
 *     vaults + rewards, so the Blue mapping mirrors our aave-v3 handler
 *     conventions instead):
 *
 *       Supply(id, caller, onBehalf, assets, shares)        → lend_supply:deposit (sent)
 *       SupplyCollateral(id, caller, onBehalf, assets)      → lend_supply:deposit (sent)
 *       Withdraw(id, caller, onBehalf, receiver, assets, …) → lend_supply:withdraw (received)
 *       WithdrawCollateral(id, caller, onBehalf, receiver,…)→ lend_supply:withdraw (received)
 *       Borrow(id, caller, onBehalf, receiver, assets, …)   → lend_borrow:borrow (received)
 *       Repay(id, caller, onBehalf, assets, shares)         → lend_borrow:repay (sent)
 *       Liquidate(id, caller, borrower, repaidAssets, …)    → TWO events at the same log
 *         (aave dual-row LIQUIDATE + PAYBACK_DEBT pattern, both spend-side):
 *         seq 0 liquidation:collateral_seized (sent: seizedAssets)
 *         seq 1 liquidation:debt_repaid       (sent: repaidAssets)
 *       FlashLoan / AccrueInterest                          → deliberately not modeled
 *         (Blue flash loans are fee-less and net-zero within the tx; interest is
 *         recognized at withdrawal/repay — same policy as aave-v3, lend_interest
 *         is never emitted).
 *
 *     Blue logs carry only the bytes32 market id, NOT token addresses: the
 *     asset is resolved from the paired same-amount ERC-20 Transfer to/from
 *     the singleton in the same receipt (Blue always moves the funds in the
 *     same call). Unresolvable legs fall back to the market id string.
 *
 *  2. **MetaMorpho (ERC-4626) vaults** — standard Deposit/Withdraw events
 *     (rotki `morpho/decoder.py` `_decode_vault_events`, reimplemented —
 *     AGPL). rotki recognizes vaults via the Morpho API cache; offline we
 *     verify a 4626 emitter as MetaMorpho iff the SAME receipt carries a Blue
 *     Supply/Withdraw with `onBehalf == emitter` (a vault deposit/withdrawal
 *     always re/de-allocates through the singleton, including the idle
 *     market). This rejects look-alike 4626 wrappers — own history's
 *     aggregator swaps route through Aave waBas* wrappers that emit the same
 *     topics (recon 2026-06-12). Shares↔assets: the event's `assets` amount
 *     is authoritative; the share-token leg is deliberately not modeled
 *     (aave aToken policy — basis carries, interest recognized at withdrawal).
 *     The vault's own Blue leg (party = vault) is skipped by the owner gate,
 *     so a vault deposit emits exactly ONE event.
 *
 *  3. **Universal Rewards Distributor** Claimed(account, reward, amount) →
 *     lend_reward:claim. rotki resolves URDs via the Morpho API; offline we
 *     pin the known Morpho-operated URD on Base. Extend MORPHO_URDS_BASE if a
 *     claim from another distributor lands in the manual queue.
 *
 * Ownership (gating per the 1d7a1fd review-fix conventions): every decoded
 * log names its economic party — `onBehalf` for Blue supply/borrow legs,
 * `borrower` for liquidations, the 4626 `owner`, the URD `account`. When
 * owner wallets are configured, logs whose party is not an owner are skipped;
 * all-foreign txs return `skip`, not `unclassified`. Bundler-wrapped calls
 * (Bundler3 + adapters, the Sickle-like proxy path) need no special casing:
 * Morpho events name the initiating user as `onBehalf`/`owner`, never the
 * bundler, so the gate is transparent (morpho-01/-02 fixtures).
 */

/** Morpho Blue singleton on Base (same vanity address on all chains — docs.morpho.org). */
export const MORPHO_BLUE_BASE = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';

/** Known Morpho-operated Universal Rewards Distributors on Base (MORPHO emissions). */
export const MORPHO_URDS_BASE: readonly string[] = [
  '0x3ef3d8ba38ebe18db133cec108f4d14ce00dd9ae',
];

// keccak256 event signatures (computed with viem `toEventSelector`,
// cross-checked against the real Base receipts in tests/fixtures/base/).
// Supply(bytes32 indexed id, address caller, address indexed onBehalf — wait, see layout notes below)
//
// Indexed layouts verified empirically against the fixture receipts:
//   Supply / SupplyCollateral / Repay : topics = [id, caller, onBehalf]; assets = data word 0
//   Withdraw / WithdrawCollateral / Borrow: topics = [id, onBehalf, receiver]; caller = data word 0, assets = data word 1
//   Liquidate: topics = [id, caller, borrower]; data words = repaidAssets, repaidShares, seizedAssets, badDebtAssets, badDebtShares
const BLUE_SUPPLY_TOPIC = '0xedf8870433c83823eb071d3df1caa8d008f12f6440918c20d75a3602cda30fe0';
const BLUE_WITHDRAW_TOPIC = '0xa56fc0ad5702ec05ce63666221f796fb62437c32db1aa1aa075fc6484cf58fbf';
const BLUE_BORROW_TOPIC = '0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43';
const BLUE_REPAY_TOPIC = '0x52acb05cebbd3cd39715469f22afbf5a17496295ef3bc9bb5944056c63ccaa09';
const BLUE_SUPPLY_COLLATERAL_TOPIC =
  '0xa3b9472a1399e17e123f3c2e6586c23e504184d504de59cdaa2b375e880c6184';
const BLUE_WITHDRAW_COLLATERAL_TOPIC =
  '0xe80ebd7cc9223d7382aab2e0d1d6155c65651f83d53c8b9b06901d167e321142';
const BLUE_LIQUIDATE_TOPIC = '0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41';

// ERC-4626 Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)
const ERC4626_DEPOSIT_TOPIC = '0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7';
// ERC-4626 Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)
const ERC4626_WITHDRAW_TOPIC =
  '0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db';
// URD Claimed(address indexed account, address indexed reward, uint256 amount)
// (= rotki's REWARD_CLAIMED constant)
const URD_CLAIMED_TOPIC = '0xf7a40077ff7a04c7e61f6f26fb13774259ddf1b6bce9ecf26a8276cdd3992683';
// ERC-20 Transfer(address indexed from, address indexed to, uint256 value)
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const BLUE_TOPICS = [
  BLUE_SUPPLY_TOPIC,
  BLUE_WITHDRAW_TOPIC,
  BLUE_BORROW_TOPIC,
  BLUE_REPAY_TOPIC,
  BLUE_SUPPLY_COLLATERAL_TOPIC,
  BLUE_WITHDRAW_COLLATERAL_TOPIC,
  BLUE_LIQUIDATE_TOPIC,
] as const;

/** Known Base tokens + the MORPHO governance/reward token. */
const MORPHO_TOKEN_SYMBOLS: Readonly<Record<string, string>> = {
  ...BASE_TOKEN_SYMBOLS,
  '0xbaa5cc21fd487b8fcc2f632f3f4e8d37262a0842': 'MORPHO',
};

/** One ERC-20 Transfer log, indexed for amount-matched token resolution. */
interface IndexedTransfer {
  logIndex: number;
  token: string;
  from: string;
  to: string;
  amount: bigint;
}

export class MorphoHandler implements Handler {
  readonly id = 'morpho';
  readonly version = 1;
  readonly chain: Chain = 'base';

  /** Cheap check: any Blue singleton market event or known-URD claim (phase-1 contract). */
  matches(raw: RawTx): boolean {
    const receipt = this.rawJson(raw)?.receipt;
    if (receipt === undefined) return false;
    return receipt.logs.some((log) => {
      const address = log.address.toLowerCase();
      const topic0 = log.topics[0] ?? '';
      if (address === MORPHO_BLUE_BASE) {
        return (BLUE_TOPICS as readonly string[]).includes(topic0);
      }
      return MORPHO_URDS_BASE.includes(address) && topic0 === URD_CLAIMED_TOPIC;
    });
  }

  decode(raw: RawTx, ctx: DecodeContext): DecodeResult {
    const rawJson = this.rawJson(raw);
    if (rawJson === undefined) {
      return { kind: 'unclassified', reason: `${this.id}: raw_json has no receipt logs` };
    }
    const owners = new Set([...ctx.wallets].map((w) => w.toLowerCase()));
    /** Empty owner set (no wallets configured) disables filtering. */
    const isOwner = (party: string): boolean => owners.size === 0 || owners.has(party);

    const logs = rawJson.receipt.logs;
    const transfers = indexTransfers(logs);
    const vaults = this.verifiedVaults(logs);

    const events: TaxEvent[] = [];
    let skippedNonOwner = false;

    for (const log of logs) {
      const address = log.address.toLowerCase();
      const topic0 = log.topics[0] ?? '';

      let decoded: TaxEvent[] | undefined;
      if (address === MORPHO_BLUE_BASE) {
        decoded = this.decodeBlueLog(raw, log, transfers);
      } else if (vaults.has(address)) {
        decoded = this.decodeVaultLog(raw, log, transfers);
      } else if (MORPHO_URDS_BASE.includes(address) && topic0 === URD_CLAIMED_TOPIC) {
        decoded = this.decodeUrdClaim(raw, log);
      }
      if (decoded === undefined) continue;
      if (!isOwner(decoded[0]!.wallet)) {
        skippedNonOwner = true;
        continue;
      }
      events.push(...decoded);
    }

    if (events.length === 0) {
      if (skippedNonOwner) return { kind: 'skip' };
      return { kind: 'unclassified', reason: `${this.id}: Morpho events present but all legs zero` };
    }
    return { kind: 'ok', events };
  }

  /**
   * MetaMorpho vault verification (offline stand-in for rotki's vault cache):
   * 4626 Deposit/Withdraw emitters that the SAME receipt names as `onBehalf`
   * of a Blue Supply/Withdraw — every vault deposit/withdrawal allocates
   * through the singleton, look-alike wrappers (Aave waBas*) never do.
   */
  private verifiedVaults(logs: readonly RawRpcLog[]): Set<string> {
    const emitters = new Set<string>();
    for (const log of logs) {
      const topic0 = log.topics[0];
      if (topic0 === ERC4626_DEPOSIT_TOPIC || topic0 === ERC4626_WITHDRAW_TOPIC) {
        emitters.add(log.address.toLowerCase());
      }
    }
    if (emitters.size === 0) return emitters;
    const verified = new Set<string>();
    for (const log of logs) {
      if (log.address.toLowerCase() !== MORPHO_BLUE_BASE) continue;
      const topic0 = log.topics[0];
      const onBehalf =
        topic0 === BLUE_SUPPLY_TOPIC
          ? topicAddress(log.topics[3]!)
          : topic0 === BLUE_WITHDRAW_TOPIC
            ? topicAddress(log.topics[2]!)
            : undefined;
      if (onBehalf !== undefined && emitters.has(onBehalf)) verified.add(onBehalf);
    }
    return verified;
  }

  /** Decode one Blue singleton log into its TaxEvents (wallet always at index 0). */
  private decodeBlueLog(
    raw: RawTx,
    log: RawRpcLog,
    transfers: readonly IndexedTransfer[],
  ): TaxEvent[] | undefined {
    const topic0 = log.topics[0];
    const logIndex = Number.parseInt(log.logIndex, 16);
    const marketId = log.topics[1] ?? 'unknown-market';
    const base = {
      chain: this.chain,
      txHash: raw.txHash,
      logIndex,
      timestamp: raw.blockTimestamp,
      handlerId: this.id,
      handlerVersion: this.version,
    } as const;
    /** Loan/collateral token via the paired same-amount transfer; market id as last resort. */
    const assetIn = (amount: bigint): string =>
      this.assetSymbol(
        nearestTransfer(transfers, logIndex, (t) => t.to === MORPHO_BLUE_BASE && t.amount === amount)
          ?.token ?? marketId,
      );
    const assetOut = (amount: bigint): string =>
      this.assetSymbol(
        nearestTransfer(
          transfers,
          logIndex,
          (t) => t.from === MORPHO_BLUE_BASE && t.amount === amount,
        )?.token ?? marketId,
      );

    if (topic0 === BLUE_SUPPLY_TOPIC || topic0 === BLUE_SUPPLY_COLLATERAL_TOPIC) {
      const amount = dataWord(log.data, 0);
      if (amount === 0n) return undefined;
      return [
        {
          ...base,
          type: 'lend_supply',
          subtype: 'deposit',
          emissionSeq: 0,
          wallet: topicAddress(log.topics[3]!), // onBehalf — the position owner
          sentAsset: assetIn(amount),
          sentAmount: amount,
        },
      ];
    }

    if (topic0 === BLUE_WITHDRAW_TOPIC || topic0 === BLUE_WITHDRAW_COLLATERAL_TOPIC) {
      const amount = dataWord(log.data, 1); // word 0 is the non-indexed caller
      if (amount === 0n) return undefined;
      return [
        {
          ...base,
          type: 'lend_supply',
          subtype: 'withdraw',
          emissionSeq: 0,
          wallet: topicAddress(log.topics[2]!), // onBehalf — owner of the position
          receivedAsset: assetOut(amount),
          receivedAmount: amount,
        },
      ];
    }

    if (topic0 === BLUE_BORROW_TOPIC) {
      const amount = dataWord(log.data, 1); // word 0 is the non-indexed caller
      if (amount === 0n) return undefined;
      return [
        {
          ...base,
          type: 'lend_borrow',
          subtype: 'borrow',
          emissionSeq: 0,
          wallet: topicAddress(log.topics[2]!), // onBehalf — gets the debt
          receivedAsset: assetOut(amount),
          receivedAmount: amount,
        },
      ];
    }

    if (topic0 === BLUE_REPAY_TOPIC) {
      const amount = dataWord(log.data, 0);
      if (amount === 0n) return undefined;
      return [
        {
          ...base,
          type: 'lend_borrow',
          subtype: 'repay',
          emissionSeq: 0,
          wallet: topicAddress(log.topics[3]!), // onBehalf — whose debt is reduced
          sentAsset: assetIn(amount),
          sentAmount: amount,
        },
      ];
    }

    if (topic0 === BLUE_LIQUIDATE_TOPIC) {
      const wallet = topicAddress(log.topics[3]!); // borrower — the liquidated owner
      const repaidAssets = dataWord(log.data, 0);
      const seizedAssets = dataWord(log.data, 2);
      return [
        {
          ...base,
          type: 'liquidation',
          subtype: 'collateral_seized',
          emissionSeq: 0,
          wallet,
          sentAsset: assetOut(seizedAssets), // seized collateral leaves the singleton to the liquidator
          sentAmount: seizedAssets,
        },
        {
          ...base,
          type: 'liquidation',
          subtype: 'debt_repaid',
          emissionSeq: 1,
          wallet,
          sentAsset: assetIn(repaidAssets), // liquidator pays the loan token into the singleton
          sentAmount: repaidAssets,
        },
      ];
    }

    return undefined; // FlashLoan / AccrueInterest / CreateMarket — not modeled
  }

  /** Decode one verified MetaMorpho vault 4626 log. Assets amount is authoritative; shares not modeled. */
  private decodeVaultLog(
    raw: RawTx,
    log: RawRpcLog,
    transfers: readonly IndexedTransfer[],
  ): TaxEvent[] | undefined {
    const topic0 = log.topics[0];
    const logIndex = Number.parseInt(log.logIndex, 16);
    const vault = log.address.toLowerCase();
    const base = {
      chain: this.chain,
      txHash: raw.txHash,
      logIndex,
      timestamp: raw.blockTimestamp,
      handlerId: this.id,
      handlerVersion: this.version,
    } as const;
    /**
     * Underlying token = the same-amount non-share transfer into/out of the
     * vault; falls back to the singleton-side transfer (the vault re/de-
     * allocates the same funds through Blue in this receipt).
     */
    const underlying = (amount: bigint, direction: 'in' | 'out'): string | undefined => {
      const direct = nearestTransfer(
        transfers,
        logIndex,
        direction === 'in'
          ? (t) => t.to === vault && t.token !== vault && t.amount === amount
          : (t) => t.from === vault && t.token !== vault && t.amount === amount,
      );
      if (direct !== undefined) return direct.token;
      return nearestTransfer(
        transfers,
        logIndex,
        direction === 'in'
          ? (t) => t.from === vault && t.to === MORPHO_BLUE_BASE
          : (t) => t.from === MORPHO_BLUE_BASE && t.to === vault,
      )?.token;
    };

    if (topic0 === ERC4626_DEPOSIT_TOPIC) {
      const assets = dataWord(log.data, 0);
      if (assets === 0n) return undefined;
      return [
        {
          ...base,
          type: 'lend_supply',
          subtype: 'deposit',
          emissionSeq: 0,
          wallet: topicAddress(log.topics[2]!), // owner — receives the shares
          sentAsset: this.assetSymbol(underlying(assets, 'in') ?? vault),
          sentAmount: assets,
        },
      ];
    }

    if (topic0 === ERC4626_WITHDRAW_TOPIC) {
      const assets = dataWord(log.data, 0);
      if (assets === 0n) return undefined;
      return [
        {
          ...base,
          type: 'lend_supply',
          subtype: 'withdraw',
          emissionSeq: 0,
          wallet: topicAddress(log.topics[3]!), // owner — whose shares are burned
          receivedAsset: this.assetSymbol(underlying(assets, 'out') ?? vault),
          receivedAmount: assets,
        },
      ];
    }

    return undefined;
  }

  /** URD Claimed → lend_reward:claim (rotki REWARD subtype; claim-time income). */
  private decodeUrdClaim(raw: RawTx, log: RawRpcLog): TaxEvent[] | undefined {
    const amount = dataWord(log.data, 0);
    if (amount === 0n) return undefined;
    return [
      {
        chain: this.chain,
        txHash: raw.txHash,
        logIndex: Number.parseInt(log.logIndex, 16),
        timestamp: raw.blockTimestamp,
        handlerId: this.id,
        handlerVersion: this.version,
        type: 'lend_reward',
        subtype: 'claim',
        emissionSeq: 0,
        wallet: topicAddress(log.topics[1]!), // account — the reward owner
        receivedAsset: this.assetSymbol(topicAddress(log.topics[2]!)),
        receivedAmount: amount,
      },
    ];
  }

  /** Asset naming convention: symbol for known Base tokens, lowercase address otherwise. */
  protected assetSymbol(tokenAddress: string): string {
    return MORPHO_TOKEN_SYMBOLS[tokenAddress] ?? tokenAddress;
  }

  private rawJson(raw: RawTx): BaseRawJson | undefined {
    const rawJson = raw.rawJson as Partial<BaseRawJson> | null;
    if (rawJson?.receipt?.logs === undefined || rawJson.tx === undefined) return undefined;
    return rawJson as BaseRawJson;
  }
}

/** uint256 data word `index` (0-based) of a log. */
function dataWord(data: string, index: number): bigint {
  const start = 2 + index * 64;
  const word = data.slice(start, start + 64);
  return word.length === 0 ? 0n : BigInt(`0x${word}`);
}

/** All ERC-20 Transfer logs of a receipt, lowercased, for amount-matched token resolution. */
function indexTransfers(logs: readonly RawRpcLog[]): IndexedTransfer[] {
  const transfers: IndexedTransfer[] = [];
  for (const log of logs) {
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
    transfers.push({
      logIndex: Number.parseInt(log.logIndex, 16),
      token: log.address.toLowerCase(),
      from: topicAddress(log.topics[1]!),
      to: topicAddress(log.topics[2]!),
      amount: dataWord(log.data, 0),
    });
  }
  return transfers;
}

/** The matching transfer nearest (by log index) to the decoded event log. */
function nearestTransfer(
  transfers: readonly IndexedTransfer[],
  logIndex: number,
  match: (t: IndexedTransfer) => boolean,
): IndexedTransfer | undefined {
  let best: IndexedTransfer | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const t of transfers) {
    if (!match(t)) continue;
    const distance = Math.abs(t.logIndex - logIndex);
    if (distance < bestDistance) {
      best = t;
      bestDistance = distance;
    }
  }
  return best;
}
