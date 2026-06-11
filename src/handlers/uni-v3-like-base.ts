import type { BaseRawJson, RawRpcLog } from '../chains/base/ingest';
import type { DecodeContext, DecodeResult, Handler, RawTx } from '../decoder/types';
import type { Chain, Flag, PositionId, Protocol, TaxEvent } from '../types/event';

/**
 * Shared decoder base for Uniswap-V3-style CLMMs on EVM ([1A.3], issue #7).
 *
 * Every V3-style NonfungiblePositionManager (NPM) — Uniswap V3 and the
 * Aerodrome Slipstream fork — emits the identical three events (see
 * `onchain/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol`
 * and `.claude/docs/repo-analysis/v3-periphery.md`: "slipstream's
 * NonfungiblePositionManager is a fork with the same event layout, so decoding
 * code is shareable — we just point at a different address"):
 *
 *   IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
 *   DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
 *   Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)
 *
 * plus the ERC-721 Transfer mint/burn of the position NFT.
 *
 * Mapping to TaxEvents (mirrors rotki's Uniswapv3CommonDecoder
 * `_decode_deposits_and_withdrawals`, adapted to offline decoding):
 *  - IncreaseLiquidity + NFT mint in tx      → lp_deposit:open_position
 *  - IncreaseLiquidity, no mint              → lp_deposit:add_liquidity
 *  - DecreaseLiquidity + NFT burn in tx      → lp_withdraw:close_position
 *  - DecreaseLiquidity, no burn              → lp_withdraw:remove_liquidity
 *  - Collect                                 → lp_fee:collect, with THE
 *    error-prone V3 split (Uniswap V3 whitepaper §6; staketaxcsv/rotki
 *    pattern): a Collect pays out principal+fees combined, so
 *    fees_i = collect.amount_i − Σ decrease.amount_i (same tokenId, same tx).
 *    Zero legs are never emitted.
 *
 * One TaxEvent per nonzero token leg, token0 first (emissionSeq 0, 1), at the
 * log index of the NPM event. `positionId` = `{chain}:{protocol}:{tokenId}`,
 * feeding the shared CLMM lifecycle tracker (`src/positions/`).
 *
 * Token addresses: rotki resolves token0/token1 via an on-chain
 * `positions(tokenId)` call; we decode offline from the receipt only, so
 * token addresses are recovered from the ERC-20 Transfer logs whose values
 * match the NPM event amounts (pool pays/receives token0 before token1).
 */

// keccak256 signatures (verified against real Base receipts in tests/fixtures/base/)
export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const INCREASE_LIQUIDITY_TOPIC =
  '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
export const DECREASE_LIQUIDITY_TOPIC =
  '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
export const COLLECT_TOPIC = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';

export const ZERO_TOPIC = `0x${'0'.repeat(64)}`;

/**
 * Base-chain ERC-20 address → symbol, for the fixture/report asset naming
 * convention (symbols, not addresses — matches the positions/eur-price
 * conventions and `src/prices/token-map.ts`). Unknown tokens fall back to
 * their lowercase address. Follow-up: lift into a shared module once the
 * aerodrome/aave handlers need it too.
 */
export const BASE_TOKEN_SYMBOLS: Readonly<Record<string, string>> = {
  '0x4200000000000000000000000000000000000006': 'WETH',
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 'USDT',
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631': 'AERO',
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 'cbBTC',
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': 'cbETH',
  '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b': 'VIRTUAL',
  // symbol() verified on-chain during fixture capture
  '0x532f27101965dd16442e59d40670faf5ebb142e4': 'BRETT',
  '0x11030f79109269d796fd0fb956d6244e502757f7': 'CTR',
};

export interface ParsedLog {
  logIndex: number;
  address: string;
  topics: string[];
  data: string;
}

export interface Erc20Transfer {
  logIndex: number;
  token: string;
  from: string;
  to: string;
  value: bigint;
}

interface NpmGroup {
  tokenId: bigint;
  increases: ParsedLog[];
  decreases: ParsedLog[];
  collects: ParsedLog[];
  minted: ParsedLog | undefined;
  burned: ParsedLog | undefined;
}

/** amounts decoded from an NPM event's data words. */
export interface LegAmounts {
  amount0: bigint;
  amount1: bigint;
}

export abstract class UniV3LikeHandler implements Handler {
  abstract readonly id: string;
  abstract readonly version: number;
  abstract readonly chain: Chain;
  /** Protocol tag used in positionIds. */
  protected abstract readonly protocol: Protocol;
  /** NonfungiblePositionManager address, lowercase. */
  protected abstract readonly positionManager: string;

  /** Cheap address+topic check against the receipt logs (phase-1 contract). */
  matches(raw: RawTx): boolean {
    const receipt = this.rawJson(raw)?.receipt;
    if (receipt === undefined) return false;
    return receipt.logs.some(
      (log) =>
        log.address.toLowerCase() === this.positionManager &&
        (log.topics[0] === INCREASE_LIQUIDITY_TOPIC ||
          log.topics[0] === DECREASE_LIQUIDITY_TOPIC ||
          log.topics[0] === COLLECT_TOPIC),
    );
  }

  /** Decode is context-free: ownership is implicit (only owner txs are ingested). */
  decode(raw: RawTx, ctx: DecodeContext): DecodeResult {
    const rawJson = this.rawJson(raw);
    if (rawJson === undefined) {
      return { kind: 'unclassified', reason: `${this.id}: raw_json has no receipt logs` };
    }
    const logs = rawJson.receipt.logs.map(parseLog);
    const transfers = erc20Transfers(logs);
    return this.decodeParsed(raw, rawJson, logs, transfers, ctx);
  }

  /**
   * Template hook over the parsed receipt: the base implementation decodes the
   * NPM events only. Protocol subclasses (Aerodrome) override this to compose
   * the NPM events with protocol-specific ones (gauges, Sickle-proxy flows)
   * and use `ctx.wallets` for owner resolution.
   */
  protected decodeParsed(
    raw: RawTx,
    rawJson: BaseRawJson,
    logs: ParsedLog[],
    transfers: Erc20Transfer[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- part of the hook contract for subclasses
    ctx: DecodeContext,
  ): DecodeResult {
    const events = this.decodeNpmEvents(raw, rawJson, logs, transfers);
    if (typeof events === 'string') return { kind: 'unclassified', reason: events };
    if (events.length === 0) {
      return { kind: 'unclassified', reason: `${this.id}: NPM events present but all legs zero` };
    }
    return { kind: 'ok', events };
  }

  /**
   * Decode all NPM events of this receipt into TaxEvents (empty when every
   * leg is zero), or return an unclassified reason string on hard failures.
   */
  protected decodeNpmEvents(
    raw: RawTx,
    rawJson: BaseRawJson,
    logs: ParsedLog[],
    transfers: Erc20Transfer[],
  ): TaxEvent[] | string {
    const groups = this.groupByTokenId(logs);
    const txFrom = rawJson.tx.from.toLowerCase();

    const events: TaxEvent[] = [];
    for (const group of groups) {
      const result = this.decodeGroup(raw, group, transfers, txFrom);
      if (typeof result === 'string') return result;
      events.push(...result);
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // Per-tokenId decoding
  // -------------------------------------------------------------------------

  /** Decode one position's NPM events in this tx, or return an unclassified reason. */
  private decodeGroup(
    raw: RawTx,
    group: NpmGroup,
    transfers: Erc20Transfer[],
    txFrom: string,
  ): TaxEvent[] | string {
    const events: TaxEvent[] = [];
    const positionId = this.positionId(group.tokenId);
    const claimed = new Set<number>();

    // --- IncreaseLiquidity → lp_deposit (token transfers go INTO the pool)
    for (const log of group.increases) {
      const amounts = legAmounts(log);
      const tokens = matchTransferPair(transfers, amounts, claimed, (t) => t.to);
      if (tokens === undefined) {
        return `${this.id}: cannot resolve token addresses for IncreaseLiquidity at log ${log.logIndex}`;
      }
      const subtype = group.minted !== undefined ? 'open_position' : 'add_liquidity';
      const wallet = this.resolveWallet(
        group.minted !== undefined ? topicAddress(group.minted.topics[2]!) : txFrom,
      );
      for (const leg of nonzeroLegs(amounts, tokens)) {
        events.push({
          type: 'lp_deposit',
          subtype,
          chain: this.chain,
          txHash: raw.txHash,
          logIndex: log.logIndex,
          emissionSeq: leg.seq,
          timestamp: raw.blockTimestamp,
          wallet,
          sentAsset: this.assetSymbol(leg.token),
          sentAmount: leg.amount,
          positionId,
          handlerId: this.id,
          handlerVersion: this.version,
        });
      }
    }

    if (group.decreases.length > 0 && group.collects.length === 0) {
      // Decrease without a same-tx collect moves nothing (amounts accrue as
      // tokensOwed in the position) and leaves no transfers to resolve token
      // addresses from offline. Rare; surface for manual labeling.
      return `${this.id}: DecreaseLiquidity without Collect in tx (tokenId ${group.tokenId}) — token addresses unresolvable offline`;
    }

    // --- Collect: resolve token0/token1 from the payout transfers, then split
    // principal (DecreaseLiquidity amounts) from fees (collect − decrease).
    if (group.collects.length > 0) {
      const collectTotals: LegAmounts = sumAmounts(group.collects);
      const decreaseTotals: LegAmounts = sumAmounts(group.decreases);
      const firstCollect = group.collects[0]!;
      const recipient = topicAddress(`0x${firstCollect.data.slice(2, 66)}`);

      // Resolve token0/token1 per Collect log — one tx can hold several
      // Collects for the same tokenId (vfat Sickle rebalances: a fee collect
      // and a principal collect), so the summed totals match no single
      // transfer. Every collect must agree on the token pair.
      let token0: string | undefined;
      let token1: string | undefined;
      for (const log of group.collects) {
        const logRecipient = topicAddress(`0x${log.data.slice(2, 66)}`);
        const logTokens = matchTransferPair(
          transfers.filter((t) => t.to === logRecipient),
          legAmounts(log),
          claimed,
          (t) => t.from,
        );
        if (logTokens === undefined) {
          return `${this.id}: cannot resolve token addresses for Collect at log ${log.logIndex}`;
        }
        if (
          (token0 !== undefined && logTokens.token0 !== undefined && logTokens.token0 !== token0) ||
          (token1 !== undefined && logTokens.token1 !== undefined && logTokens.token1 !== token1)
        ) {
          return `${this.id}: conflicting token addresses across Collect logs (tokenId ${group.tokenId})`;
        }
        token0 ??= logTokens.token0;
        token1 ??= logTokens.token1;
      }
      const tokens = { token0, token1 };

      // principal legs at the DecreaseLiquidity log(s)
      const subtype = group.burned !== undefined ? 'close_position' : 'remove_liquidity';
      for (const log of group.decreases) {
        for (const leg of nonzeroLegs(legAmounts(log), tokens)) {
          events.push({
            type: 'lp_withdraw',
            subtype,
            chain: this.chain,
            txHash: raw.txHash,
            logIndex: log.logIndex,
            emissionSeq: leg.seq,
            timestamp: raw.blockTimestamp,
            wallet: this.resolveWallet(recipient),
            receivedAsset: this.assetSymbol(leg.token),
            receivedAmount: leg.amount,
            positionId,
            handlerId: this.id,
            handlerVersion: this.version,
          });
        }
      }

      // fee legs at the Collect log: collect − principal
      const feeAmounts: LegAmounts = {
        amount0: collectTotals.amount0 - decreaseTotals.amount0,
        amount1: collectTotals.amount1 - decreaseTotals.amount1,
      };
      if (feeAmounts.amount0 < 0n || feeAmounts.amount1 < 0n) {
        return `${this.id}: Collect amounts smaller than DecreaseLiquidity amounts (tokenId ${group.tokenId}) — fee split impossible`;
      }
      // A Collect with no same-tx DecreaseLiquidity is USUALLY a pure fee
      // harvest, but it also pays out tokensOwed of a decrease from an EARLIER
      // tx (which decoded to unclassified — see above). The fee/principal
      // split cannot tell the two apart offline, so the legs are flagged:
      // the §23/§22 engine and the TUI must pair flagged collects with any
      // unresolved prior-decrease sibling before trusting them as income.
      const collectOnlyFlags: Flag[] | undefined =
        group.decreases.length === 0 ? ['collect_without_same_tx_decrease'] : undefined;
      for (const leg of nonzeroLegs(feeAmounts, tokens)) {
        events.push({
          type: 'lp_fee',
          subtype: 'collect',
          chain: this.chain,
          txHash: raw.txHash,
          logIndex: firstCollect.logIndex,
          emissionSeq: leg.seq,
          timestamp: raw.blockTimestamp,
          wallet: this.resolveWallet(recipient),
          receivedAsset: this.assetSymbol(leg.token),
          receivedAmount: leg.amount,
          positionId,
          ...(collectOnlyFlags === undefined ? {} : { flags: collectOnlyFlags }),
          handlerId: this.id,
          handlerVersion: this.version,
        });
      }
    }

    return events;
  }

  // -------------------------------------------------------------------------
  // Overridable hooks
  // -------------------------------------------------------------------------

  /** Asset naming: symbol for known Base tokens, lowercase address otherwise. */
  protected assetSymbol(tokenAddress: string): string {
    return BASE_TOKEN_SYMBOLS[tokenAddress] ?? tokenAddress;
  }

  /**
   * Wallet attribution hook: receives the on-chain actor (mint recipient,
   * collect recipient, or tx sender) and returns the wallet to put on the
   * TaxEvent. Identity here; Aerodrome maps vfat Sickle proxy contracts (and
   * keeper senders) to the owner EOA.
   */
  protected resolveWallet(wallet: string): string {
    return wallet;
  }

  protected positionId(tokenId: bigint): PositionId {
    return `${this.chain}:${this.protocol}:${tokenId.toString()}`;
  }

  // -------------------------------------------------------------------------
  // Receipt parsing
  // -------------------------------------------------------------------------

  protected rawJson(raw: RawTx): BaseRawJson | undefined {
    const rawJson = raw.rawJson as Partial<BaseRawJson> | null;
    if (rawJson?.receipt?.logs === undefined || rawJson.tx === undefined) return undefined;
    return rawJson as BaseRawJson;
  }

  /** Group the NPM logs of this receipt by position tokenId, in first-log order. */
  private groupByTokenId(logs: ParsedLog[]): NpmGroup[] {
    const groups = new Map<bigint, NpmGroup>();
    const groupFor = (tokenId: bigint): NpmGroup => {
      let group = groups.get(tokenId);
      if (group === undefined) {
        group = {
          tokenId,
          increases: [],
          decreases: [],
          collects: [],
          minted: undefined,
          burned: undefined,
        };
        groups.set(tokenId, group);
      }
      return group;
    };

    for (const log of logs) {
      if (log.address !== this.positionManager) continue;
      const topic0 = log.topics[0];
      if (topic0 === INCREASE_LIQUIDITY_TOPIC) {
        groupFor(BigInt(log.topics[1]!)).increases.push(log);
      } else if (topic0 === DECREASE_LIQUIDITY_TOPIC) {
        groupFor(BigInt(log.topics[1]!)).decreases.push(log);
      } else if (topic0 === COLLECT_TOPIC) {
        groupFor(BigInt(log.topics[1]!)).collects.push(log);
      } else if (topic0 === TRANSFER_TOPIC && log.topics.length === 4) {
        // ERC-721 position NFT mint/burn
        const tokenId = BigInt(log.topics[3]!);
        if (log.topics[1] === ZERO_TOPIC) groupFor(tokenId).minted = log;
        else if (log.topics[2] === ZERO_TOPIC) groupFor(tokenId).burned = log;
      }
    }
    // Drop NFT-only groups (e.g. plain position transfers — no NPM liquidity event).
    return [...groups.values()].filter(
      (g) => g.increases.length + g.decreases.length + g.collects.length > 0,
    );
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function parseLog(log: RawRpcLog): ParsedLog {
  return {
    logIndex: Number.parseInt(log.logIndex, 16),
    address: log.address.toLowerCase(),
    topics: log.topics,
    data: log.data,
  };
}

/** All ERC-20 Transfer logs (3 topics — ERC-721 Transfers carry 4) in log order. */
function erc20Transfers(logs: ParsedLog[]): Erc20Transfer[] {
  return logs
    .filter((log) => log.topics[0] === TRANSFER_TOPIC && log.topics.length === 3)
    .map((log) => ({
      logIndex: log.logIndex,
      token: log.address,
      from: topicAddress(log.topics[1]!),
      to: topicAddress(log.topics[2]!),
      value: BigInt(log.data === '0x' ? '0x0' : log.data),
    }));
}

/** `amount0`/`amount1` are data words 1 and 2 for all three NPM events. */
export function legAmounts(log: ParsedLog): LegAmounts {
  const data = log.data.slice(2);
  return {
    amount0: BigInt(`0x${data.slice(64, 128) || '0'}`),
    amount1: BigInt(`0x${data.slice(128, 192) || '0'}`),
  };
}

function sumAmounts(logs: ParsedLog[]): LegAmounts {
  let amount0 = 0n;
  let amount1 = 0n;
  for (const log of logs) {
    const amounts = legAmounts(log);
    amount0 += amounts.amount0;
    amount1 += amounts.amount1;
  }
  return { amount0, amount1 };
}

/**
 * Recover (token0, token1) addresses by matching NPM event amounts against the
 * receipt's ERC-20 Transfer values: claim, in log order, the first unclaimed
 * transfer matching amount0, then amount1 (the pool moves token0 before
 * token1, which also disambiguates the equal-amounts case). Both matched
 * transfers must share the same counterparty (`side`: the pool — `to` for
 * deposits, `from` for payouts). Zero legs need no transfer; returns
 * undefined when a nonzero leg has no matching transfer.
 */
function matchTransferPair(
  transfers: Erc20Transfer[],
  amounts: LegAmounts,
  claimed: Set<number>,
  side: (t: Erc20Transfer) => string,
): { token0: string | undefined; token1: string | undefined } | undefined {
  const take = (value: bigint, counterparty: string | undefined): Erc20Transfer | undefined => {
    const match = transfers.find(
      (t) =>
        !claimed.has(t.logIndex) &&
        t.value === value &&
        (counterparty === undefined || side(t) === counterparty),
    );
    if (match !== undefined) claimed.add(match.logIndex);
    return match;
  };

  let t0: Erc20Transfer | undefined;
  if (amounts.amount0 > 0n) {
    t0 = take(amounts.amount0, undefined);
    if (t0 === undefined) return undefined;
  }
  let t1: Erc20Transfer | undefined;
  if (amounts.amount1 > 0n) {
    t1 = take(amounts.amount1, t0 === undefined ? undefined : side(t0));
    if (t1 === undefined) return undefined;
  }
  return { token0: t0?.token, token1: t1?.token };
}

/** Nonzero token legs in canonical order: token0 (seq 0) then token1. */
function nonzeroLegs(
  amounts: LegAmounts,
  tokens: { token0: string | undefined; token1: string | undefined },
): Array<{ seq: number; token: string; amount: bigint }> {
  const legs: Array<{ seq: number; token: string; amount: bigint }> = [];
  if (amounts.amount0 > 0n && tokens.token0 !== undefined) {
    legs.push({ seq: legs.length, token: tokens.token0, amount: amounts.amount0 });
  }
  if (amounts.amount1 > 0n && tokens.token1 !== undefined) {
    legs.push({ seq: legs.length, token: tokens.token1, amount: amounts.amount1 });
  }
  return legs;
}

/** Last 20 bytes of a 32-byte topic/word, lowercase `0x`-prefixed. */
export function topicAddress(word: string): string {
  return `0x${word.slice(-40)}`.toLowerCase();
}
