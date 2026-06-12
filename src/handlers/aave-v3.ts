import { dataWord, topicAddress } from '../chains/base/log-utils';
import { asBaseRawJson, type BaseRawJson, type RawRpcLog } from '../chains/base/raw-json';
import { baseTokenSymbol } from '../chains/base/tokens';
import type { DecodeContext, DecodeResult, Handler, RawTx } from '../decoder/types';
import type { Chain, TaxEvent } from '../types/event';

/**
 * Aave V3 handler for Base ([1A.5], issue #9). viem-native repo: no ethers,
 * no aave-utilities — the five Pool events are decoded offline from the
 * receipt logs, with signatures hand-verified against
 * `onchain/aave-v3-core/contracts/interfaces/IPool.sol` (the canonical ABI
 * source, see `.claude/docs/repo-analysis/aave-v3-core.md`) and against the
 * real Base receipts in `tests/fixtures/base/aave_v3-*.json`.
 *
 * Event → TaxEvent mapping (mirrors rotki's
 * `rotkehlchen/chain/evm/decoding/aave/v3/decoder.py` Pool-event mapping,
 * reimplemented — AGPL):
 *
 *   Supply(reserve, user, onBehalfOf, amount, ref) → lend_supply:deposit (sent)
 *   Withdraw(reserve, user, to, amount)            → lend_supply:withdraw (received)
 *   Borrow(reserve, user, onBehalfOf, amount, …)   → lend_borrow:borrow (received)
 *   Repay(reserve, user, repayer, amount, useAT)   → lend_borrow:repay (sent)
 *   LiquidationCall(collateral, debt, user, …)     → TWO events at the same log
 *     (rotki's dual-row LIQUIDATE + PAYBACK_DEBT pattern, both spend-side):
 *     seq 0 liquidation:collateral_seized (sent: liquidatedCollateralAmount)
 *     seq 1 liquidation:debt_repaid       (sent: debtToCover)
 *
 * Amounts are the Pool event's underlying-asset amounts. The aToken /
 * debt-token Mint/Burn legs (RAY-scaled balances, where interest accrues) are
 * deliberately NOT modeled: interest is recognized at withdrawal — a Withdraw
 * amount already includes accrued interest, so no separate event is needed and
 * the reserved `lend_interest` type is never emitted in MVP (locked decision,
 * `src/types/event.ts`). Revisit `WadRayMath`/`scaledBalanceOf` only if a
 * future lend_interest follow-up lands.
 *
 * Ownership: each Pool log names its economic party (onBehalfOf for
 * supply/borrow, user for withdraw/repay/liquidation). When owner wallets are
 * configured for the chain, logs whose party is not an owner are skipped —
 * this silences aggregator swaps that route through Aave wrapper contracts
 * (the wrapper, not Felix, is the Pool user; fixture 01 notes) and foreign
 * legs batched into the same receipt. All-foreign txs return `skip`, not
 * `unclassified`, so swap handlers / generic rules still own the tx.
 *
 * Not in MVP (absent from own history and fixtures): WrappedTokenGatewayV3
 * native-ETH flows (the Pool party is the gateway contract → skipped),
 * aToken-funded repays (`useATokens=true` — still decoded as a plain repay),
 * RewardsController incentive claims, and FlashLoan premiums.
 */

/** Aave V3 Pool on Base (= `AaveV3Base.POOL` in @bgd-labs/aave-address-book; verified against the fixture receipts). */
export const AAVE_V3_POOL_BASE = '0xa238dd80c259a72e81d7e4664a9801593f98d1c5';

// keccak256 event signatures from IPool.sol (computed with viem
// `toEventSelector`, cross-checked against the real Base receipts in
// tests/fixtures/base/aave_v3-*.json).
// Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)
const SUPPLY_TOPIC = '0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61';
// Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)
const WITHDRAW_TOPIC = '0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7';
// Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)
const BORROW_TOPIC = '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0';
// Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)
const REPAY_TOPIC = '0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051';
// LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)
const LIQUIDATION_CALL_TOPIC = '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286';

const POOL_TOPICS = [
  SUPPLY_TOPIC,
  WITHDRAW_TOPIC,
  BORROW_TOPIC,
  REPAY_TOPIC,
  LIQUIDATION_CALL_TOPIC,
] as const;

export class AaveV3Handler implements Handler {
  readonly id = 'aave_v3';
  readonly version = 1;
  readonly chain: Chain = 'base';
  protected readonly pool = AAVE_V3_POOL_BASE;

  /** Cheap check: any decodable Pool event in the receipt (phase-1 contract). */
  matches(raw: RawTx): boolean {
    const receipt = this.rawJson(raw)?.receipt;
    if (receipt === undefined) return false;
    return receipt.logs.some(
      (log) =>
        log.address.toLowerCase() === this.pool &&
        (POOL_TOPICS as readonly string[]).includes(log.topics[0] ?? ''),
    );
  }

  decode(raw: RawTx, ctx: DecodeContext): DecodeResult {
    const rawJson = this.rawJson(raw);
    if (rawJson === undefined) {
      return { kind: 'unclassified', reason: `${this.id}: raw_json has no receipt logs` };
    }
    const owners = new Set([...ctx.wallets].map((w) => w.toLowerCase()));
    /** Empty owner set (no wallets configured) disables filtering. */
    const isOwner = (party: string): boolean => owners.size === 0 || owners.has(party);

    const events: TaxEvent[] = [];
    let skippedNonOwner = false;

    for (const log of rawJson.receipt.logs) {
      if (log.address.toLowerCase() !== this.pool) continue;
      const decoded = this.decodePoolLog(raw, log);
      if (decoded === undefined) continue;
      if (!isOwner(decoded[0]!.wallet)) {
        skippedNonOwner = true;
        continue;
      }
      events.push(...decoded);
    }

    if (events.length === 0) {
      if (skippedNonOwner) return { kind: 'skip' };
      return { kind: 'unclassified', reason: `${this.id}: Pool events present but all legs zero` };
    }
    return { kind: 'ok', events };
  }

  /**
   * Decode one Pool log into its TaxEvents (all attributed to the same
   * wallet, always at index 0), or undefined for non-decoded topics and
   * zero-amount legs.
   */
  private decodePoolLog(raw: RawTx, log: RawRpcLog): TaxEvent[] | undefined {
    const topic0 = log.topics[0];
    const logIndex = Number.parseInt(log.logIndex, 16);
    const base = {
      chain: this.chain,
      txHash: raw.txHash,
      logIndex,
      timestamp: raw.blockTimestamp,
      handlerId: this.id,
      handlerVersion: this.version,
    } as const;

    if (topic0 === SUPPLY_TOPIC) {
      const amount = dataWord(log.data, 1);
      if (amount === 0n) return undefined;
      return [
        {
          ...base,
          type: 'lend_supply',
          subtype: 'deposit',
          emissionSeq: 0,
          wallet: topicAddress(log.topics[2]!), // onBehalfOf — the position owner
          sentAsset: this.assetSymbol(topicAddress(log.topics[1]!)),
          sentAmount: amount,
        },
      ];
    }

    if (topic0 === WITHDRAW_TOPIC) {
      const amount = dataWord(log.data, 0);
      if (amount === 0n) return undefined;
      return [
        {
          ...base,
          type: 'lend_supply',
          subtype: 'withdraw',
          emissionSeq: 0,
          wallet: topicAddress(log.topics[2]!), // user — owner of the aTokens
          receivedAsset: this.assetSymbol(topicAddress(log.topics[1]!)),
          receivedAmount: amount,
        },
      ];
    }

    if (topic0 === BORROW_TOPIC) {
      const amount = dataWord(log.data, 1);
      if (amount === 0n) return undefined;
      return [
        {
          ...base,
          type: 'lend_borrow',
          subtype: 'borrow',
          emissionSeq: 0,
          wallet: topicAddress(log.topics[2]!), // onBehalfOf — gets the debt
          receivedAsset: this.assetSymbol(topicAddress(log.topics[1]!)),
          receivedAmount: amount,
        },
      ];
    }

    if (topic0 === REPAY_TOPIC) {
      const amount = dataWord(log.data, 0);
      if (amount === 0n) return undefined;
      return [
        {
          ...base,
          type: 'lend_borrow',
          subtype: 'repay',
          emissionSeq: 0,
          wallet: topicAddress(log.topics[2]!), // user — whose debt is reduced
          sentAsset: this.assetSymbol(topicAddress(log.topics[1]!)),
          sentAmount: amount,
        },
      ];
    }

    if (topic0 === LIQUIDATION_CALL_TOPIC) {
      const wallet = topicAddress(log.topics[3]!); // user — the liquidated owner
      const debtToCover = dataWord(log.data, 0);
      const collateralAmount = dataWord(log.data, 1);
      return [
        {
          ...base,
          type: 'liquidation',
          subtype: 'collateral_seized',
          emissionSeq: 0,
          wallet,
          sentAsset: this.assetSymbol(topicAddress(log.topics[1]!)),
          sentAmount: collateralAmount,
        },
        {
          ...base,
          type: 'liquidation',
          subtype: 'debt_repaid',
          emissionSeq: 1,
          wallet,
          sentAsset: this.assetSymbol(topicAddress(log.topics[2]!)),
          sentAmount: debtToCover,
        },
      ];
    }

    return undefined;
  }

  /** Asset naming convention: symbol for known Base tokens, lowercase address otherwise. */
  protected assetSymbol(tokenAddress: string): string {
    return baseTokenSymbol(tokenAddress);
  }

  private rawJson(raw: RawTx): BaseRawJson | undefined {
    return asBaseRawJson(raw.rawJson);
  }
}
