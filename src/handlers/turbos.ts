import type { DecodeContext, DecodeResult, Handler, RawTx } from '../decoder/types';
import type { Flag, PositionId, TaxEvent } from '../types/event';
import {
  TURBOS_EVENT_TYPES,
  TURBOS_PACKAGE_CURRENT,
  TURBOS_PACKAGE_V1,
  type TurbosCollectEvent,
  type TurbosCollectEventV2,
  type TurbosCollectRewardEventV2,
  type TurbosPoolBurnEvent,
  type TurbosPoolMintEvent,
  type TurbosSwapEvent,
} from '../types/turbos-events';

/**
 * [1C.3] Turbos CLMM phase-1 handler.
 *
 * Event-driven decode over the tx's `SuiEvent[]` (per the U0 spike,
 * `docs/sui-event-discovery.md`): every Turbos action emits a pool-level
 * event carrying amounts + the position-NFT `owner` (the duplicated
 * `position_manager::*` companion events carry no owner and emit nothing).
 * Matching is by FULL event type string against the defining package IDs
 * (v1 vs current, mixed within one tx — see the U0 doc) plus the Move-call
 * target packages, mirroring the `turbos-clmm-sdk` integration sketch
 * (`.claude/docs/repo-analysis/turbos-clmm-sdk.md`: classify per
 * `position_manager::mint/increase_liquidity/decrease_liquidity/collect/
 * collect_reward/burn`, take amounts from events).
 *
 * Conventions pinned by the golden fixtures
 * (`tests/fixtures/sui/turbos-*.json`):
 * - `logIndex` = index in the tx's `events` array; one TaxEvent per nonzero
 *   token leg (`emissionSeq` counts nonzero legs, coin A before coin B);
 *   zero-amount legs/events (Turbos' burn(0) fee-poke, inactive reward
 *   vaults) emit nothing.
 * - `positionId` = `sui:turbos:<position-NFT object id>` (the pool events'
 *   `owner` field) in ALL cases. The NFT id is the one id present in every
 *   lifecycle tx — open (MintNftEvent.nft_address), harvest/increase (the
 *   `owner` of Collect/Mint events), close (BurnNftEvent.nft_address) — so
 *   one CLMM lifecycle reduces to ONE position row. The in-pool position id
 *   from Mint/BurnNftEvent is NOT used (it never appears in harvest-only
 *   txs and would split the lifecycle into phantom rows). Same-tx NFT
 *   mint/burn still decides the subtype (open_position/close_position vs
 *   add_liquidity/remove_liquidity).
 * - Pool token order (amount_a/amount_b -> coin types) comes from the Turbos
 *   Move calls' `type_arguments` (`[CoinA, CoinB, FeeType]`), keyed by the
 *   call's pool object input; asset = last `::` segment of the coin type
 *   (SUI, USDC, ...), matching the sui fixture conventions.
 * - Zap/rebalance txs route their embedded swap through an aggregator
 *   (FlowX `universal_router::Swap`, 7k `settle::Swap`): the aggregator's
 *   total event becomes ONE collapsed `swap:trade` (multi-hop convention from
 *   the base/solana fixtures) flagged `rebalance_embedded`, and the per-hop
 *   Turbos `pool::SwapEvent`s are suppressed.
 */

const HANDLER_ID = 'turbos';
const HANDLER_VERSION = 1;

const TURBOS_PACKAGES: ReadonlySet<string> = new Set([TURBOS_PACKAGE_V1, TURBOS_PACKAGE_CURRENT]);
const TURBOS_TYPE_PREFIXES = [`${TURBOS_PACKAGE_V1}::`, `${TURBOS_PACKAGE_CURRENT}::`] as const;

/** Known-type lookup: full event type string -> key in TURBOS_EVENT_TYPES. */
const TYPE_TO_KEY: ReadonlyMap<string, keyof typeof TURBOS_EVENT_TYPES> = new Map(
  (Object.entries(TURBOS_EVENT_TYPES) as [keyof typeof TURBOS_EVENT_TYPES, string][]).map(
    ([key, type]) => [type, key],
  ),
);

/**
 * Aggregator route-total events (suffix-matched — router packages are
 * upgraded/redeployed often), in preference order: when the first suffix
 * yields a match the later ones are ignored (fixture turbos-02 carries BOTH
 * the FlowX `universal_router::Swap` and a mirroring 7k `settle::Swap`; only
 * the first is emitted).
 */
const AGGREGATOR_TOTAL_SUFFIXES = ['::universal_router::Swap', '::settle::Swap'] as const;

interface AggregatorSwapPayload {
  amount_in?: string;
  amount_out?: string;
  coin_in?: { name?: string };
  coin_out?: { name?: string };
  swapper?: string;
  sender?: string;
}

interface SuiEventShape {
  type?: string;
  parsedJson?: unknown;
}

interface SuiMoveCallShape {
  package?: string;
  module?: string;
  function?: string;
  type_arguments?: readonly string[];
  arguments?: readonly unknown[];
}

interface SuiInputShape {
  type?: string;
  objectId?: string;
}

interface RawJsonShape {
  events?: readonly SuiEventShape[];
  transaction?: {
    data?: {
      sender?: string;
      transaction?: {
        inputs?: readonly SuiInputShape[];
        transactions?: readonly { MoveCall?: SuiMoveCallShape }[];
      };
    };
  };
}

function suiEvents(raw: RawTx): readonly SuiEventShape[] {
  return (raw.rawJson as RawJsonShape).events ?? [];
}

function ptb(raw: RawTx): {
  sender: string | undefined;
  inputs: readonly SuiInputShape[];
  moveCalls: readonly SuiMoveCallShape[];
} {
  const data = (raw.rawJson as RawJsonShape).transaction?.data;
  const tx = data?.transaction;
  return {
    sender: data?.sender,
    inputs: tx?.inputs ?? [],
    moveCalls: (tx?.transactions ?? [])
      .map((command) => command.MoveCall)
      .filter((call): call is SuiMoveCallShape => call !== undefined),
  };
}

function isTurbosType(type: string): boolean {
  return TURBOS_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/** "0x2::sui::SUI" / "dba3…::usdc::USDC" (TypeName, no 0x) -> "SUI" / "USDC". */
function coinSymbol(coinType: string): string {
  const segments = coinType.split('::');
  return segments[segments.length - 1] ?? coinType;
}

/**
 * pool object id -> [coinTypeA, coinTypeB], from the Turbos Move calls'
 * `type_arguments` ([CoinA, CoinB, FeeType, ...]) keyed by every object
 * input of the call — the pool object is always among them; non-pool objects
 * (position NFT, versioned, clock) also get entries but are never looked up.
 */
function buildPoolCoins(raw: RawTx): ReadonlyMap<string, readonly [string, string]> {
  const { inputs, moveCalls } = ptb(raw);
  const poolCoins = new Map<string, readonly [string, string]>();
  for (const call of moveCalls) {
    if (call.package === undefined || !TURBOS_PACKAGES.has(call.package)) continue;
    const typeArgs = call.type_arguments ?? [];
    if (typeArgs.length < 2) continue;
    for (const argument of call.arguments ?? []) {
      const inputIndex = (argument as { Input?: number } | null)?.Input;
      if (inputIndex === undefined) continue;
      const input = inputs[inputIndex];
      if (input?.type === 'object' && input.objectId !== undefined) {
        poolCoins.set(input.objectId, [typeArgs[0], typeArgs[1]]);
      }
    }
  }
  return poolCoins;
}

/** Nonzero (asset, amount) legs of a two-sided pool event, coin A first. */
function pairLegs(
  pool: string,
  amountA: string,
  amountB: string,
  poolCoins: ReadonlyMap<string, readonly [string, string]>,
): { asset: string; amount: bigint }[] | string {
  const coins = poolCoins.get(pool);
  if (coins === undefined) return `no Turbos move call resolves coin types of pool ${pool}`;
  return [
    { asset: coinSymbol(coins[0]), amount: BigInt(amountA) },
    { asset: coinSymbol(coins[1]), amount: BigInt(amountB) },
  ].filter((leg) => leg.amount > 0n);
}

export const turbosHandler: Handler = {
  id: HANDLER_ID,
  version: HANDLER_VERSION,
  chain: 'sui',

  /** Cheap check: any Turbos-defined event, or a Move call into a Turbos package. */
  matches(raw: RawTx): boolean {
    if (raw.chain !== 'sui') return false;
    if (suiEvents(raw).some((event) => event.type !== undefined && isTurbosType(event.type))) {
      return true;
    }
    return ptb(raw).moveCalls.some(
      (call) => call.package !== undefined && TURBOS_PACKAGES.has(call.package),
    );
  },

  decode(raw: RawTx, ctx: DecodeContext): DecodeResult {
    const { sender } = ptb(raw);
    // PTB sender owns every action in the block; Turbos activity in a
    // foreign-sender tx (e.g. someone else's aggregator route) is not ours —
    // any coins we received are phase-2 generic-transfer territory.
    if (sender === undefined || !ctx.wallets.has(sender)) return { kind: 'skip' };

    const events = suiEvents(raw);
    const poolCoins = buildPoolCoins(raw);

    // Pass 1 — NFT lifecycle markers: which NFTs were minted/burned in THIS
    // tx (decides open/close subtypes). The positionId is ALWAYS the NFT
    // object id — stable across open/harvest/increase/close txs (see header).
    const mintedNfts = new Set<string>();
    const burnedNfts = new Set<string>();
    for (const event of events) {
      const key = event.type === undefined ? undefined : TYPE_TO_KEY.get(event.type);
      if (key !== 'mintNft' && key !== 'burnNft' && key !== 'burnPosition') continue;
      const payload = event.parsedJson as { nft_address?: string };
      if (payload.nft_address === undefined) continue;
      (key === 'mintNft' ? mintedNfts : burnedNfts).add(payload.nft_address);
    }
    const positionIdOf = (nftAddress: string): PositionId => `sui:${HANDLER_ID}:${nftAddress}`;

    // Pass 2 — aggregator route totals (zap swaps): first matching suffix wins.
    const aggregatorIndexes = new Set<number>();
    for (const suffix of AGGREGATOR_TOTAL_SUFFIXES) {
      for (const [index, event] of events.entries()) {
        if (event.type === undefined || !event.type.endsWith(suffix)) continue;
        const payload = event.parsedJson as AggregatorSwapPayload;
        if (payload.amount_in === undefined || payload.coin_in?.name === undefined) continue;
        if ((payload.swapper ?? payload.sender) !== sender) continue;
        aggregatorIndexes.add(index);
      }
      if (aggregatorIndexes.size > 0) break;
    }

    const hasPositionActivity = events.some((event) => {
      const key = event.type === undefined ? undefined : TYPE_TO_KEY.get(event.type);
      return key !== undefined && key !== 'swap' && key !== 'poolCreated';
    });

    const taxEvents: TaxEvent[] = [];
    const problems: string[] = [];
    const base = {
      chain: 'sui' as const,
      txHash: raw.txHash,
      timestamp: raw.blockTimestamp,
      wallet: sender,
      handlerId: HANDLER_ID,
      handlerVersion: HANDLER_VERSION,
    };

    const pushLegs = (
      logIndex: number,
      type: 'lp_deposit' | 'lp_withdraw' | 'lp_fee',
      subtype: TaxEvent['subtype'],
      legsOrError: { asset: string; amount: bigint }[] | string,
      positionId: PositionId | undefined,
      side: 'sent' | 'received',
    ): void => {
      if (typeof legsOrError === 'string') {
        problems.push(`${type} at event index ${logIndex}: ${legsOrError}`);
        return;
      }
      legsOrError.forEach((leg, emissionSeq) => {
        taxEvents.push({
          ...base,
          type,
          subtype,
          logIndex,
          emissionSeq,
          positionId,
          ...(side === 'sent'
            ? { sentAsset: leg.asset, sentAmount: leg.amount }
            : { receivedAsset: leg.asset, receivedAmount: leg.amount }),
        } as TaxEvent);
      });
    };

    for (const [index, event] of events.entries()) {
      if (event.type === undefined) continue;

      // Collapsed aggregator total — the one swap:trade of a zap/rebalance tx.
      // Dominant-protocol convention: when an earlier handler (navi/suilend —
      // turbos registers last on sui) already claimed this aggregator summary
      // event, the route is theirs and our pool was just one hop — defer.
      // Deduplication is per ROUTE, not per index: one route can emit TWO
      // mirroring summaries (turbos-02: universal_router::Swap + settle::Swap),
      // and the earlier handler may have claimed the OTHER mirror — comparing
      // the trade totals catches that where the index comparison cannot.
      if (aggregatorIndexes.has(index)) {
        const payload = event.parsedJson as AggregatorSwapPayload;
        const sentAmount = BigInt(payload.amount_in ?? '0');
        const receivedAmount = BigInt(payload.amount_out ?? '0');
        const alreadyClaimed = ctx.decodedEvents.some(
          (claimed) =>
            claimed.logIndex === index ||
            (claimed.type === 'swap' &&
              claimed.sentAmount === sentAmount &&
              claimed.receivedAmount === receivedAmount),
        );
        if (alreadyClaimed) continue;
        const flags: Flag[] | undefined = hasPositionActivity ? ['rebalance_embedded'] : undefined;
        taxEvents.push({
          ...base,
          type: 'swap',
          subtype: 'trade',
          logIndex: index,
          emissionSeq: 0,
          sentAsset: coinSymbol(payload.coin_in?.name ?? ''),
          sentAmount: BigInt(payload.amount_in ?? '0'),
          receivedAsset: coinSymbol(payload.coin_out?.name ?? ''),
          receivedAmount: BigInt(payload.amount_out ?? '0'),
          ...(flags === undefined ? {} : { flags }),
        });
        continue;
      }

      const key = TYPE_TO_KEY.get(event.type);
      if (key === undefined) {
        // Unknown event from a Turbos package = new struct after an upgrade —
        // route to the manual queue instead of silently dropping (U0 doc §4).
        if (isTurbosType(event.type)) {
          problems.push(`unknown Turbos event '${event.type}' at event index ${index}`);
        }
        continue; // other protocols' events are not ours to decode
      }

      switch (key) {
        case 'poolMint': {
          const payload = event.parsedJson as TurbosPoolMintEvent;
          pushLegs(
            index,
            'lp_deposit',
            mintedNfts.has(payload.owner) ? 'open_position' : 'add_liquidity',
            pairLegs(payload.pool, payload.amount_a, payload.amount_b, poolCoins),
            positionIdOf(payload.owner),
            'sent',
          );
          break;
        }
        case 'poolBurn': {
          const payload = event.parsedJson as TurbosPoolBurnEvent;
          // burn(0) fee-poke before collects: zero legs, nothing taxable.
          if (BigInt(payload.amount_a) === 0n && BigInt(payload.amount_b) === 0n) break;
          pushLegs(
            index,
            'lp_withdraw',
            burnedNfts.has(payload.owner) ? 'close_position' : 'remove_liquidity',
            pairLegs(payload.pool, payload.amount_a, payload.amount_b, poolCoins),
            positionIdOf(payload.owner),
            'received',
          );
          break;
        }
        case 'collect':
        case 'collectV2': {
          const payload = event.parsedJson as TurbosCollectEvent & Partial<TurbosCollectEventV2>;
          if (BigInt(payload.amount_a) === 0n && BigInt(payload.amount_b) === 0n) break;
          pushLegs(
            index,
            'lp_fee',
            'collect',
            pairLegs(payload.pool, payload.amount_a, payload.amount_b, poolCoins),
            // v1 CollectEvent carries no owner — no positionId (recipient only).
            payload.owner === undefined ? undefined : positionIdOf(payload.owner),
            'received',
          );
          break;
        }
        case 'collectRewardV2': {
          const payload = event.parsedJson as TurbosCollectRewardEventV2;
          const amount = BigInt(payload.amount);
          if (amount === 0n) break; // inactive emissions vault
          taxEvents.push({
            ...base,
            type: 'lp_reward',
            subtype: 'emission_claim',
            logIndex: index,
            emissionSeq: 0,
            receivedAsset: coinSymbol(payload.reward_type.name),
            receivedAmount: amount,
            positionId: positionIdOf(payload.owner),
          });
          break;
        }
        case 'collectReward': {
          // v1 (2023–2024 era) reward event has no coin type and no owner;
          // resolving the vault -> reward coin needs state not present in the
          // tx. No own-history coverage — manual queue until a fixture exists.
          const amount = BigInt((event.parsedJson as { amount: string }).amount);
          if (amount === 0n) break;
          problems.push(`v1 CollectRewardEvent at event index ${index}: reward coin unresolved`);
          break;
        }
        case 'swap': {
          // Per-hop pool swap. Inside an aggregator route the total event
          // already covers it (collapsed multi-hop convention).
          if (aggregatorIndexes.size > 0) break;
          const payload = event.parsedJson as TurbosSwapEvent;
          const legsOrError = pairLegs(payload.pool, payload.amount_a, payload.amount_b, poolCoins);
          if (typeof legsOrError === 'string') {
            // Typical shape: a third-party aggregator (7K, OKX, Mayan, …)
            // routed one hop through a Turbos pool — the swap belongs to the
            // aggregator route, whose total event we do not recognize.
            problems.push(
              `swap at event index ${index}: ${legsOrError} — likely an aggregator route ` +
                'with an unrecognized total event; needs aggregator handling',
            );
            break;
          }
          const [coinA, coinB] = legsOrError;
          const [sent, received] = payload.a_to_b ? [coinA, coinB] : [coinB, coinA];
          if (sent === undefined || received === undefined) break; // zero-amount swap
          taxEvents.push({
            ...base,
            type: 'swap',
            subtype: 'trade',
            logIndex: index,
            emissionSeq: 0,
            sentAsset: sent.asset,
            sentAmount: sent.amount,
            receivedAsset: received.asset,
            receivedAmount: received.amount,
          });
          break;
        }
        // Ownerless position_manager duplicates of the pool events above, NFT
        // link markers (consumed in pass 1), and non-tax admin events.
        case 'increaseLiquidity':
        case 'decreaseLiquidity':
        case 'pmCollect':
        case 'pmCollectReward':
        case 'mintNft':
        case 'burnNft':
        case 'burnPosition':
        case 'mintNftV1':
        case 'poolCreated':
        case 'collectProtocolFee':
          break;
      }
    }

    // Partial decodes must not silently understate taxable activity.
    if (problems.length > 0) return { kind: 'unclassified', reason: problems.join('; ') };
    // Turbos tx with nothing taxable (all-zero harvest, failed PTB).
    if (taxEvents.length === 0) return { kind: 'skip' };
    return { kind: 'ok', events: taxEvents };
  },
};
