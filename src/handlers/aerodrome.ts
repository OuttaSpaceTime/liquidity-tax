import {
  signedWord,
  topicAddress,
  type Erc20Transfer,
  type ParsedLog,
} from '../chains/base/log-utils';
import type { BaseRawJson } from '../chains/base/raw-json';
import type { DecodeContext, DecodeResult, RawTx } from '../decoder/types';
import type { Chain, Protocol, TaxEvent } from '../types/event';
import { UniV3LikeHandler } from './uni-v3-like-base';

/**
 * Aerodrome handler for Base ([1A.4], issue #8).
 *
 * Slipstream CL positions are a Uniswap V3 NPM fork (same event layout,
 * different address — `.claude/docs/repo-analysis/v3-periphery.md`), so the LP
 * lifecycle decoding is fully inherited from `UniV3LikeHandler`, mirroring
 * rotki's `AerodromeDecoder(VelodromeLikeDecoder)` fork-inheritance pattern
 * (`onchain/rotki/rotkehlchen/chain/base/modules/aerodrome/decoder.py`).
 *
 * On top of the NPM events this handler decodes, offline from the receipt:
 *
 *  - **Gauge ops** (rotki `_decode_gauge_events`): staked CL positions earn
 *    AERO emissions instead of swap fees. `ClaimRewards(from, amount)` →
 *    `lp_reward:gauge_claim` (gross, at the claim log) — deliberately distinct
 *    from `lp_fee:collect` (pool fees of unstaked positions). CL gauge
 *    `Deposit`/`Withdraw` (NFT staking) emit **nothing**: the position stays
 *    economically the owner's. Gauge addresses are discovered from the gauge
 *    event topics themselves (rotki uses an on-chain cache; we are offline).
 *
 *  - **vfat Sickle proxy custody**: position NFTs are held by a per-user
 *    Sickle contract; deposits/withdraws/harvests flow through it. Sickles
 *    are taken from the ingest's verified discovery (`raw_json.addresses`
 *    carries the eth_getCode-probed enumeration targets — wallets + Sickles;
 *    see `src/chains/base/ingest.ts` discoverSickles), never inferred from
 *    arbitrary NPM counterparties: a third party's proxy must not become
 *    "our Sickle". Owner/proxy actors are attributed to the owner EOA
 *    (`resolveWallet`); when no configured wallet can be resolved from the
 *    tx sender or the receipt's transfers (keeper-triggered automation whose
 *    rewards stay in the Sickle) the tx goes to the manual queue — never to
 *    `tx.from` (the keeper). Sickle↔owner transfers (dust sweeps, net
 *    forwards) are suppressed as internal. Sickle→third-party transfers
 *    (vfat performance/ops fee skims) become `transfer:send` flagged
 *    `vfat_fee`; income legs stay gross, matching the 2025 filed report
 *    convention (fixture 03 notes).
 *
 *  - **Zaps**: WETH `Deposit`/`Withdrawal` for the Sickle/owner →
 *    `transfer:wrap`/`transfer:unwrap`; CL pool `Swap` logs → `swap:trade`,
 *    with token addresses recovered from the transfers touching the pool and
 *    the whole same-value routing chain (Sickle → executor(s) → pool → … →
 *    Sickle) claimed so intermediary hops emit nothing.
 *
 *  - **Non-gauge AERO receipts** default to `transfer:receive` (documented
 *    edge case): an unclaimed AERO transfer to the owner/Sickle from an
 *    address that is not a gauge/pool/NPM cannot be attributed to emissions
 *    offline, so it is recorded as a plain receipt.
 *
 * Not covered (absent from the owner's history and the fixtures): classic
 * Aerodrome v2 AMM pools and their gauges, veAERO voting escrow, bribe/voter
 * reward claims.
 */

/** Slipstream NonfungiblePositionManager on Base (fork of Uniswap V3 NPM). */
export const AERODROME_SLIPSTREAM_NPM = '0x827922686190790b37229fd06084350e74485b72';

const AERO_TOKEN = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';
const WETH_TOKEN = '0x4200000000000000000000000000000000000006';

// Gauge events (verified against real Base receipts in tests/fixtures/base/;
// ClaimRewards matches rotki's CLAIM_REWARDS_V2 constant).
// keccak256("ClaimRewards(address,uint256)")
const GAUGE_CLAIM_REWARDS_TOPIC =
  '0x1f89f96333d3133000ee447473151fa9606543368f02271c9d95ae14f13bcc67';
// keccak256("Deposit(address,uint256,uint128)") — CL gauge NFT stake
const CL_GAUGE_DEPOSIT_TOPIC =
  '0x1c8ab8c7f45390d58f58f1d655213a82cca5d12179761a87c16f098813b8f211';
// keccak256("Withdraw(address,uint256,uint128)") — CL gauge NFT unstake
const CL_GAUGE_WITHDRAW_TOPIC =
  '0x8903a5b5d08a841e7f68438387f1da20c84dea756379ed37e633ff3854b99b84';

// CL pool events (Uniswap V3 pool layout)
const POOL_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const POOL_MINT_TOPIC = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde';
const POOL_BURN_TOPIC = '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c';
const POOL_COLLECT_TOPIC = '0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0';

// WETH9
const WETH_DEPOSIT_TOPIC = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';
const WETH_WITHDRAWAL_TOPIC =
  '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';

const GAUGE_TOPICS = [
  GAUGE_CLAIM_REWARDS_TOPIC,
  CL_GAUGE_DEPOSIT_TOPIC,
  CL_GAUGE_WITHDRAW_TOPIC,
] as const;

const POOL_TOPICS = [
  POOL_SWAP_TOPIC,
  POOL_MINT_TOPIC,
  POOL_BURN_TOPIC,
  POOL_COLLECT_TOPIC,
] as const;

/** Address roles discovered from one receipt, driving wallet mapping and transfer rules. */
interface TxRoles {
  /** The owner EOA every event is attributed to. */
  owner: string;
  /** All configured owner wallets (lowercase). */
  owners: Set<string>;
  /** vfat Sickle proxy contracts acting for the owner in this tx. */
  proxies: Set<string>;
  /** Gauge contracts (emitted a gauge event in this tx). */
  gauges: Set<string>;
  /** CL pools (emitted a pool event in this tx). */
  pools: Set<string>;
}

export class AerodromeHandler extends UniV3LikeHandler {
  readonly id = 'aerodrome';
  readonly version = 1;
  readonly chain: Chain = 'base';
  protected readonly protocol: Protocol = 'aerodrome';
  protected readonly positionManager = AERODROME_SLIPSTREAM_NPM;

  /** Roles of the tx currently being decoded (set for the duration of decodeParsed). */
  private roles: TxRoles | undefined;

  /** Slipstream NPM events (inherited check) or any Aerodrome gauge event. */
  override matches(raw: RawTx): boolean {
    if (super.matches(raw)) return true;
    const receipt = (raw.rawJson as Partial<BaseRawJson> | null)?.receipt;
    if (receipt === undefined) return false;
    return receipt.logs.some((log) =>
      (GAUGE_TOPICS as readonly string[]).includes(log.topics[0] ?? ''),
    );
  }

  protected override decodeParsed(
    raw: RawTx,
    rawJson: BaseRawJson,
    logs: ParsedLog[],
    transfers: Erc20Transfer[],
    ctx: DecodeContext,
  ): DecodeResult {
    const owners = new Set([...ctx.wallets].map((w) => w.toLowerCase()));
    const txFrom = rawJson.tx.from.toLowerCase();
    const gauges = addressesEmitting(logs, GAUGE_TOPICS);
    const pools = addressesEmitting(logs, POOL_TOPICS);
    // Verified Sickle proxies only: the ingest's enumeration targets for this
    // tx (eth_getCode-probed Sickle discovery) minus the owner wallets. Never
    // infer proxies from arbitrary receipt counterparties — a third party's
    // Sickle/router must not be attributed to us.
    const proxies = new Set(
      (rawJson.addresses ?? []).map((a) => a.toLowerCase()).filter((a) => !owners.has(a)),
    );
    const owner = resolveOwner(owners, txFrom, transfers);
    if (owner === undefined) {
      // Keeper-triggered Sickle automation whose funds stay in the Sickle: no
      // configured wallet appears anywhere — manual queue, never tx.from.
      return {
        kind: 'unclassified',
        reason: `${this.id}: no configured owner wallet resolvable from tx sender or transfers (keeper-triggered Sickle tx?)`,
      };
    }
    const roles: TxRoles = { owner, owners, proxies, gauges, pools };

    this.roles = roles;
    try {
      const npmEvents = this.decodeNpmEvents(raw, rawJson, logs, transfers);
      if (typeof npmEvents === 'string') return { kind: 'unclassified', reason: npmEvents };

      const events: TaxEvent[] = [...npmEvents];
      /** Transfer log indexes consumed by the rules below (NPM matching keeps its own set). */
      const claimed = new Set<number>();
      const gaugeEvents = this.decodeGaugeClaims(raw, logs, transfers, claimed, roles);
      if (typeof gaugeEvents === 'string') return { kind: 'unclassified', reason: gaugeEvents };
      events.push(...gaugeEvents);
      events.push(...this.decodeSwaps(raw, logs, transfers, claimed, roles));
      events.push(...this.decodeWraps(raw, rawJson, logs, roles));
      events.push(...this.decodeSickleSkims(raw, transfers, claimed, roles));
      events.push(...this.decodeAeroReceives(raw, transfers, claimed, roles));

      if (events.length === 0) {
        // Gauge NFT stake/unstake (and their zero-amount fee settlements)
        // are intentionally silent — the position is still the owner's.
        if (gauges.size > 0) return { kind: 'skip' };
        return {
          kind: 'unclassified',
          reason: `${this.id}: Slipstream NPM events present but all legs zero`,
        };
      }
      return { kind: 'ok', events };
    } finally {
      this.roles = undefined;
    }
  }

  /**
   * Sickle == owner economically: attribute VERIFIED proxy actors to the
   * owner EOA. Owners stay themselves; unknown third parties stay themselves
   * too (no coercion — foreign actors must never become the owner).
   */
  protected override resolveWallet(wallet: string): string {
    const roles = this.roles;
    if (roles === undefined) return wallet;
    return roles.proxies.has(wallet) ? roles.owner : wallet;
  }

  // ---------------------------------------------------------------------------
  // Gauge rewards
  // ---------------------------------------------------------------------------

  /**
   * ClaimRewards → lp_reward:gauge_claim (gross; skims are separate
   * transfer:send), ONLY when the economic party — the ClaimRewards claimer
   * topic or the payout transfer's recipient — is an owner or a verified
   * proxy. Foreign claims batched into the same receipt emit nothing.
   * A claim that IS ours but has no matching payout transfer cannot be
   * asset-resolved offline (the ClaimRewards topic is shared by other gauge
   * forks whose reward token is not AERO) — manual queue instead of guessing.
   */
  private decodeGaugeClaims(
    raw: RawTx,
    logs: ParsedLog[],
    transfers: Erc20Transfer[],
    claimed: Set<number>,
    roles: TxRoles,
  ): TaxEvent[] | string {
    const isOurs = (address: string | undefined): boolean =>
      address !== undefined && (roles.owners.has(address) || roles.proxies.has(address));
    const events: TaxEvent[] = [];
    for (const log of logs) {
      if (log.topics[0] !== GAUGE_CLAIM_REWARDS_TOPIC || log.topics.length < 2) continue;
      const amount = BigInt(log.data === '0x' ? '0x0' : log.data);
      if (amount === 0n) continue;
      const claimer = topicAddress(log.topics[1]!);
      const payout = transfers.find(
        (t) => !claimed.has(t.logIndex) && t.from === log.address && t.value === amount,
      );
      if (!isOurs(claimer) && !isOurs(payout?.to)) continue; // someone else's claim
      if (payout === undefined) {
        return `${this.id}: ClaimRewards at log ${log.logIndex} has no matching payout transfer — reward asset unresolvable offline`;
      }
      claimed.add(payout.logIndex);
      events.push({
        type: 'lp_reward',
        subtype: 'gauge_claim',
        chain: this.chain,
        txHash: raw.txHash,
        logIndex: log.logIndex,
        emissionSeq: 0,
        timestamp: raw.blockTimestamp,
        wallet: roles.owner,
        receivedAsset: this.assetSymbol(payout.token),
        receivedAmount: amount,
        handlerId: this.id,
        handlerVersion: this.version,
      });
    }
    return events;
  }

  // ---------------------------------------------------------------------------
  // Zap legs: pool swaps and WETH wraps
  // ---------------------------------------------------------------------------

  /**
   * One swap:trade per CL pool Swap log. Token addresses come from the
   * transfers touching the pool with the exact event amounts; the entire
   * same-value routing chain is claimed so executor hops are not re-emitted
   * as sends/receives.
   */
  private decodeSwaps(
    raw: RawTx,
    logs: ParsedLog[],
    transfers: Erc20Transfer[],
    claimed: Set<number>,
    roles: TxRoles,
  ): TaxEvent[] {
    const events: TaxEvent[] = [];
    for (const log of logs) {
      if (log.topics[0] !== POOL_SWAP_TOPIC) continue;
      const amount0 = signedWord(log.data, 0);
      const amount1 = signedWord(log.data, 1);
      if (amount0 === 0n || amount1 === 0n || amount0 > 0n === amount1 > 0n) continue;
      const [amountIn, amountOut] = amount0 > 0n ? [amount0, -amount1] : [amount1, -amount0];
      const pool = log.address;
      const transferIn = transfers.find(
        (t) => !claimed.has(t.logIndex) && t.to === pool && t.value === amountIn,
      );
      const transferOut = transfers.find(
        (t) => !claimed.has(t.logIndex) && t.from === pool && t.value === amountOut,
      );
      // Not offline-resolvable (e.g. someone else's swap batched into the
      // receipt, or a partial-fill aggregator) — emit nothing for this log.
      if (transferIn === undefined || transferOut === undefined) continue;
      // Ownership gate: some endpoint of the same-value routing chain must be
      // an owner or a verified proxy — a foreign swap that merely shares the
      // receipt is not our trade.
      const involved = transfers.some(
        (t) =>
          ((t.token === transferIn.token && t.value === amountIn) ||
            (t.token === transferOut.token && t.value === amountOut)) &&
          (roles.owners.has(t.from) ||
            roles.owners.has(t.to) ||
            roles.proxies.has(t.from) ||
            roles.proxies.has(t.to)),
      );
      if (!involved) continue;
      for (const t of transfers) {
        if (
          (t.token === transferIn.token && t.value === amountIn) ||
          (t.token === transferOut.token && t.value === amountOut)
        ) {
          claimed.add(t.logIndex);
        }
      }
      events.push({
        type: 'swap',
        subtype: 'trade',
        chain: this.chain,
        txHash: raw.txHash,
        logIndex: log.logIndex,
        emissionSeq: 0,
        timestamp: raw.blockTimestamp,
        wallet: roles.owner,
        sentAsset: this.assetSymbol(transferIn.token),
        sentAmount: amountIn,
        receivedAsset: this.assetSymbol(transferOut.token),
        receivedAmount: amountOut,
        handlerId: this.id,
        handlerVersion: this.version,
      });
    }
    return events;
  }

  /**
   * WETH Deposit/Withdrawal for the Sickle or the owner → transfer:wrap /
   * unwrap. When the owner funded a Sickle call with raw ETH (`tx.value`) and
   * the Sickle wrapped LESS than that, the delta is the vfat fee taken in raw
   * ETH (no log of its own — recovered offline as tx.value − Σ wrapped):
   * emitted as transfer:send flagged `vfat_fee` at the first wrap log.
   */
  private decodeWraps(
    raw: RawTx,
    rawJson: BaseRawJson,
    logs: ParsedLog[],
    roles: TxRoles,
  ): TaxEvent[] {
    const events: TaxEvent[] = [];
    const involved = (address: string): boolean =>
      roles.owners.has(address) || roles.proxies.has(address);
    let wrappedTotal = 0n;
    let firstWrapLogIndex: number | undefined;
    for (const log of logs) {
      if (log.address !== WETH_TOKEN || log.topics.length < 2) continue;
      const topic0 = log.topics[0];
      if (topic0 !== WETH_DEPOSIT_TOPIC && topic0 !== WETH_WITHDRAWAL_TOPIC) continue;
      if (!involved(topicAddress(log.topics[1]!))) continue;
      const amount = BigInt(log.data === '0x' ? '0x0' : log.data);
      if (amount === 0n) continue;
      const wrap = topic0 === WETH_DEPOSIT_TOPIC;
      if (wrap) {
        wrappedTotal += amount;
        firstWrapLogIndex ??= log.logIndex;
      }
      events.push({
        type: 'transfer',
        subtype: wrap ? 'wrap' : 'unwrap',
        chain: this.chain,
        txHash: raw.txHash,
        logIndex: log.logIndex,
        emissionSeq: 0,
        timestamp: raw.blockTimestamp,
        wallet: roles.owner,
        sentAsset: wrap ? 'ETH' : 'WETH',
        sentAmount: amount,
        receivedAsset: wrap ? 'WETH' : 'ETH',
        receivedAmount: amount,
        handlerId: this.id,
        handlerVersion: this.version,
      });
    }

    // vfat raw-ETH fee: only meaningful on owner-funded Sickle calls.
    const txValue = BigInt(rawJson.tx.value ?? '0x0');
    if (
      roles.proxies.size > 0 &&
      roles.owners.has(rawJson.tx.from.toLowerCase()) &&
      firstWrapLogIndex !== undefined &&
      txValue > wrappedTotal
    ) {
      events.push({
        type: 'transfer',
        subtype: 'send',
        chain: this.chain,
        txHash: raw.txHash,
        logIndex: firstWrapLogIndex,
        emissionSeq: 1,
        timestamp: raw.blockTimestamp,
        wallet: roles.owner,
        sentAsset: 'ETH',
        sentAmount: txValue - wrappedTotal,
        flags: ['vfat_fee'],
        handlerId: this.id,
        handlerVersion: this.version,
      });
    }
    return events;
  }

  // ---------------------------------------------------------------------------
  // Sickle transfer fallbacks
  // ---------------------------------------------------------------------------

  /**
   * Unclaimed Sickle→third-party transfers are vfat fee skims →
   * transfer:send flagged `vfat_fee`, so the §23/§22 engine can classify them
   * as deductible expense / in-kind disposal deterministically (2025 filed
   * report convention: income gross + skim as separate expense). Sickle↔owner
   * transfers (dust sweeps, net forwards) emit nothing: Sickle == owner
   * economically.
   */
  private decodeSickleSkims(
    raw: RawTx,
    transfers: Erc20Transfer[],
    claimed: Set<number>,
    roles: TxRoles,
  ): TaxEvent[] {
    const events: TaxEvent[] = [];
    for (const t of transfers) {
      if (claimed.has(t.logIndex) || t.value === 0n) continue;
      if (!roles.proxies.has(t.from)) continue;
      if (
        roles.owners.has(t.to) ||
        roles.proxies.has(t.to) ||
        roles.pools.has(t.to) ||
        roles.gauges.has(t.to) ||
        t.to === this.positionManager
      ) {
        continue;
      }
      claimed.add(t.logIndex);
      events.push({
        type: 'transfer',
        subtype: 'send',
        chain: this.chain,
        txHash: raw.txHash,
        logIndex: t.logIndex,
        emissionSeq: 0,
        timestamp: raw.blockTimestamp,
        wallet: roles.owner,
        sentAsset: this.assetSymbol(t.token),
        sentAmount: t.value,
        flags: ['vfat_fee'],
        handlerId: this.id,
        handlerVersion: this.version,
      });
    }
    return events;
  }

  /**
   * Documented edge case (issue #8): an AERO receipt that is not a gauge
   * payout (and not from a pool/NPM/our own proxy) cannot be attributed to
   * emissions offline — default it to a plain transfer:receive.
   */
  private decodeAeroReceives(
    raw: RawTx,
    transfers: Erc20Transfer[],
    claimed: Set<number>,
    roles: TxRoles,
  ): TaxEvent[] {
    const events: TaxEvent[] = [];
    for (const t of transfers) {
      if (claimed.has(t.logIndex) || t.value === 0n || t.token !== AERO_TOKEN) continue;
      if (!roles.owners.has(t.to) && !roles.proxies.has(t.to)) continue;
      if (
        roles.owners.has(t.from) ||
        roles.proxies.has(t.from) ||
        roles.gauges.has(t.from) ||
        roles.pools.has(t.from) ||
        t.from === this.positionManager
      ) {
        continue;
      }
      claimed.add(t.logIndex);
      events.push({
        type: 'transfer',
        subtype: 'receive',
        chain: this.chain,
        txHash: raw.txHash,
        logIndex: t.logIndex,
        emissionSeq: 0,
        timestamp: raw.blockTimestamp,
        wallet: roles.owner,
        receivedAsset: this.assetSymbol(t.token),
        receivedAmount: t.value,
        handlerId: this.id,
        handlerVersion: this.version,
      });
    }
    return events;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Addresses that emitted any log with one of the given topic0 values. */
function addressesEmitting(logs: ParsedLog[], topics: readonly string[]): Set<string> {
  const addresses = new Set<string>();
  for (const log of logs) {
    if (topics.includes(log.topics[0] ?? '')) addresses.add(log.address);
  }
  return addresses;
}

/**
 * The owner EOA to attribute events to: the tx sender when it is a configured
 * wallet (user-triggered vfat call), otherwise the first configured wallet
 * appearing in the receipt's transfers (keeper-triggered automation with a
 * Sickle→owner forward). `undefined` when no configured wallet appears at all
 * — the caller must route the tx to the manual queue, NEVER to tx.from (a
 * vfat keeper would otherwise swallow the owner's income).
 */
function resolveOwner(
  owners: Set<string>,
  txFrom: string,
  transfers: Erc20Transfer[],
): string | undefined {
  if (owners.has(txFrom)) return txFrom;
  for (const t of transfers) {
    if (owners.has(t.to)) return t.to;
    if (owners.has(t.from)) return t.from;
  }
  return undefined;
}
