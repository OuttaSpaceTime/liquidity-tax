import 'server-only';
import { eq, isNull, sql } from 'drizzle-orm';
import { db } from './db';
import { events, positions, rawTxs, transferLinks, unclassified } from '@db/schema';
import {
  listPositions,
  positionState,
  getPosition,
  type PositionRow,
} from '@lt/positions/repo';
import {
  recentActivity,
  getEventsByPosition,
  getEventsByTx,
  listTransactions,
  countEventsByChain,
  type EventRow,
} from '@lt/db/repos/events';
import { getPricesForPairs, getLatestPrices, priceKey } from '@lt/prices/repo';
import type { PriceRow } from '@lt/prices/repo';
import { utcDateOf } from '@lt/prices/dates';
import type { Chain, TaxEventType } from '@lt/types/event';
import type { AssetTotals } from '@lt/positions/tracker';
import { assetDecimals, assetSymbol, daysBetween, daysUntilTaxFree } from './format';
import { eventVerb, protocolOf, INCOME_TYPES, type EventVerb } from './taxonomy';
import { walletLabelMap, labelFor, type WalletInfo } from './wallet-labels';

/** Wall-clock now in unix seconds. Centralized so date math is consistent. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// DTOs — all serializable (no bigint), safe to pass to Client Components.
// ---------------------------------------------------------------------------

export interface AmountDTO {
  asset: string; // display symbol (WETH→ETH etc.)
  rawAsset: string; // asset id as stored on the event
  amount: string; // decimal string of base units
  formatted: string;
  scaled: boolean; // false ⇒ decimals unknown, shown as raw integer
  eur: number | null;
}

export interface PositionDTO {
  positionId: string;
  chain: Chain;
  protocol: string;
  walletLabel: string;
  openedAt: number;
  closedAt: number | null;
  status: 'open' | 'closed';
  ageDays: number;
  holdingDays: number | null; // closed only
  daysUntilTaxFree: number; // open only (approx)
  inferredOpen: boolean;
  eventCount: number;
  principal: AmountDTO[];
  deposited: AmountDTO[];
  withdrawn: AmountDTO[];
  feesCollected: AmountDTO[];
  rewardsCollected: AmountDTO[];
  warnings: string[];
  estValueEur: number | null;
  estValueNote: 'ok' | 'negative_principal' | 'no_price';
  harvestedEur: number | null;
  openTxHash: string | null;
  closeTxHash: string | null;
}

export interface ActivityDTO {
  id: number;
  chain: Chain;
  protocol: string;
  walletLabel: string;
  timestamp: number;
  type: string;
  subtype: string;
  verb: EventVerb;
  sent: AmountDTO | null;
  received: AmountDTO | null;
  eurValue: number | null;
  positionId: string | null;
  flags: string[];
  txHash: string;
  isIncome: boolean;
}

export interface Cursor {
  timestamp: number;
  id: number;
}

// ---------------------------------------------------------------------------
// Valuation helpers (price key = the event asset string verbatim — that is how
// the price backfill stores rows; see src/prices/manifest.ts).
// ---------------------------------------------------------------------------

function humanAmount(chain: Chain, asset: string, amount: bigint | string): {
  formatted: string;
  scaled: boolean;
  human: number | null;
} {
  const decimals = assetDecimals(chain, asset);
  const raw = typeof amount === 'bigint' ? amount : BigInt(amount);
  if (decimals === undefined) {
    return { formatted: raw.toLocaleString('de-DE'), scaled: false, human: null };
  }
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const fracStr = (v % base)
    .toString()
    .padStart(decimals, '0')
    .slice(0, 6)
    .replace(/0+$/, '');
  const formatted = `${neg ? '-' : ''}${(v / base).toLocaleString('de-DE')}${fracStr ? ',' + fracStr : ''}`;
  return { formatted, scaled: true, human: Number(raw) / 10 ** decimals };
}

function buildAmount(
  chain: Chain,
  asset: string,
  amount: bigint | string,
  price: PriceRow | undefined,
): AmountDTO {
  const { formatted, scaled, human } = humanAmount(chain, asset, amount);
  const eur = human !== null && price?.eurPrice != null ? human * price.eurPrice : null;
  return { asset: assetSymbol(chain, asset), rawAsset: asset, amount: String(amount), formatted, scaled, eur };
}

function totalsToAmounts(
  chain: Chain,
  totals: AssetTotals,
  priceByAsset: Map<string, PriceRow>,
): AmountDTO[] {
  return Object.entries(totals)
    .filter(([, v]) => v !== '0')
    .map(([asset, amount]) => buildAmount(chain, asset, amount, priceByAsset.get(asset)));
}

/** Sum a set of amounts to EUR, reporting why a total is unavailable. */
function sumEur(amounts: AmountDTO[]): { eur: number | null; note: 'ok' | 'negative_principal' | 'no_price' } {
  if (amounts.length === 0) return { eur: 0, note: 'ok' };
  if (amounts.some((a) => a.amount.startsWith('-'))) return { eur: null, note: 'negative_principal' };
  if (amounts.some((a) => a.eur === null)) return { eur: null, note: 'no_price' };
  return { eur: amounts.reduce((s, a) => s + (a.eur ?? 0), 0), note: 'ok' };
}

/** Sum only the amounts that could be priced (a ≥ lower-bound estimate). */
function sumEurLenient(amounts: AmountDTO[]): number | null {
  const priced = amounts.filter((a) => a.eur !== null);
  return priced.length === 0 ? null : priced.reduce((s, a) => s + (a.eur ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

function assetsOfState(s: ReturnType<typeof positionState>): string[] {
  return [
    ...Object.keys(s.principal),
    ...Object.keys(s.feesCollected),
    ...Object.keys(s.rewardsCollected),
    ...Object.keys(s.deposited),
    ...Object.keys(s.withdrawn),
  ];
}

function toPositionDTO(
  row: PositionRow,
  labels: Map<string, WalletInfo>,
  latest: Map<string, PriceRow>,
  now: number,
): PositionDTO {
  const chain = row.chain as Chain;
  const s = positionState(row);
  const principal = totalsToAmounts(chain, s.principal, latest);
  const est = sumEur(principal);
  const harvested = [
    ...totalsToAmounts(chain, s.feesCollected, latest),
    ...totalsToAmounts(chain, s.rewardsCollected, latest),
  ];
  return {
    positionId: row.positionId,
    chain,
    protocol: row.protocol,
    walletLabel: labelFor(labels, row.wallet),
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    status: s.status,
    ageDays: daysBetween(row.openedAt, now),
    holdingDays: row.closedAt !== null ? daysBetween(row.openedAt, row.closedAt) : null,
    daysUntilTaxFree: daysUntilTaxFree(row.openedAt, now),
    inferredOpen: s.inferredOpen,
    eventCount: s.eventCount,
    principal,
    deposited: totalsToAmounts(chain, s.deposited, latest),
    withdrawn: totalsToAmounts(chain, s.withdrawn, latest),
    feesCollected: totalsToAmounts(chain, s.feesCollected, latest),
    rewardsCollected: totalsToAmounts(chain, s.rewardsCollected, latest),
    warnings: s.warnings,
    estValueEur: est.eur,
    estValueNote: est.note,
    harvestedEur: sumEurLenient(harvested),
    openTxHash: s.openTxHash,
    closeTxHash: s.closeTxHash,
  };
}

async function decoratePositions(rows: PositionRow[]): Promise<PositionDTO[]> {
  const labels = await walletLabelMap();
  const assets = new Set<string>();
  for (const row of rows) for (const a of assetsOfState(positionState(row))) assets.add(a);
  const latest = getLatestPrices(db, [...assets]);
  const now = nowSeconds();
  return rows.map((row) => toPositionDTO(row, labels, latest, now));
}

export interface PositionFilters {
  chain?: Chain;
  wallet?: string;
}

export async function getOpenPositions(filters: PositionFilters = {}): Promise<PositionDTO[]> {
  return decoratePositions(listPositions(db, { ...filters, openOnly: true }));
}

export async function getClosedPositions(
  filters: PositionFilters = {},
  limit = 100,
): Promise<PositionDTO[]> {
  return decoratePositions(
    listPositions(db, { ...filters, closedOnly: true, orderBy: 'closed_desc', limit }),
  );
}

export interface PositionDetailDTO {
  position: PositionDTO;
  timeline: ActivityDTO[];
}

export async function getPositionDetail(positionId: string): Promise<PositionDetailDTO | null> {
  const row = getPosition(db, positionId);
  if (row === undefined) return null;
  const [position] = await decoratePositions([row]);
  const timeline = await decorateActivity(getEventsByPosition(db, positionId));
  return { position, timeline };
}

// ---------------------------------------------------------------------------
// Activity / transactions
// ---------------------------------------------------------------------------

function legPair(e: EventRow): Array<{ asset: string; date: string }> {
  const date = utcDateOf(e.timestamp);
  const out: Array<{ asset: string; date: string }> = [];
  if (e.sentAsset) out.push({ asset: e.sentAsset, date });
  if (e.receivedAsset) out.push({ asset: e.receivedAsset, date });
  return out;
}

async function decorateActivity(rows: EventRow[]): Promise<ActivityDTO[]> {
  const labels = await walletLabelMap();
  const pairs = rows.flatMap(legPair);
  const priceMap = getPricesForPairs(db, pairs);
  return rows.map((e) => {
    const chain = e.chain as Chain;
    const date = utcDateOf(e.timestamp);
    const sent =
      e.sentAsset && e.sentAmount !== null
        ? buildAmount(chain, e.sentAsset, e.sentAmount, priceMap.get(priceKey(e.sentAsset, date)))
        : null;
    const received =
      e.receivedAsset && e.receivedAmount !== null
        ? buildAmount(chain, e.receivedAsset, e.receivedAmount, priceMap.get(priceKey(e.receivedAsset, date)))
        : null;
    return {
      id: e.id,
      chain,
      protocol: protocolOf(e.positionId, e.handlerId),
      walletLabel: labelFor(labels, e.wallet),
      timestamp: e.timestamp,
      type: e.type,
      subtype: e.subtype,
      verb: eventVerb(e.type, e.subtype),
      sent,
      received,
      eurValue: received?.eur ?? sent?.eur ?? null,
      positionId: e.positionId,
      flags: (e.flagsJson as string[] | null) ?? [],
      txHash: e.txHash,
      isIncome: INCOME_TYPES.has(e.type as TaxEventType),
    };
  });
}

export interface ActivityFilters {
  chain?: Chain;
  wallet?: string;
  type?: TaxEventType;
  positionId?: string;
}

export interface ActivityPage {
  items: ActivityDTO[];
  nextCursor: Cursor | null;
}

export async function getActivity(
  filters: ActivityFilters = {},
  cursor: Cursor | null = null,
  limit = 50,
): Promise<ActivityPage> {
  const rows = recentActivity(db, { ...filters, cursor, limit: limit + 1 });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = await decorateActivity(page);
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? { timestamp: last.timestamp, id: last.id } : null,
  };
}

export interface TxGroupDTO {
  chain: Chain;
  txHash: string;
  timestamp: number;
  eventCount: number;
  events: ActivityDTO[];
}

export async function getTransactions(
  filters: { chain?: Chain; wallet?: string } = {},
  limit = 50,
  offset = 0,
): Promise<TxGroupDTO[]> {
  const groups = listTransactions(db, { ...filters, limit, offset });
  const out: TxGroupDTO[] = [];
  for (const g of groups) {
    const evRows = getEventsByTx(db, g.chain, g.txHash);
    out.push({
      chain: g.chain as Chain,
      txHash: g.txHash,
      timestamp: g.timestamp,
      eventCount: g.eventCount,
      events: await decorateActivity(evRows),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Overview rollup
// ---------------------------------------------------------------------------

export interface OverviewDTO {
  openPositions: number;
  closedPositions: number;
  eventsByChain: Array<{ chain: string; count: number }>;
  totalEvents: number;
  unclassifiedOpen: number;
  pendingLinks: number;
  lastIngestAt: number | null;
  lastEventAt: number | null;
  protocols: Array<{ protocol: string; open: number }>;
  harvestedEur: number | null;
  recent: ActivityDTO[];
}

function scalar(q: { get(): { n: number | null } | undefined }): number | null {
  return q.get()?.n ?? null;
}

export interface Freshness {
  lastIngestAt: number | null;
  lastEventAt: number | null;
}

/** Cheap freshness probe for the top bar (readonly WAL reader can lag the CLI). */
export function getFreshness(): Freshness {
  return {
    lastIngestAt: scalar(db.select({ n: sql<number>`max(${rawTxs.fetchedAt})` }).from(rawTxs)),
    lastEventAt: scalar(db.select({ n: sql<number>`max(${events.timestamp})` }).from(events)),
  };
}

export async function getOverview(): Promise<OverviewDTO> {
  const openRows = listPositions(db, { openOnly: true });
  const closedCount =
    scalar(
      db.select({ n: sql<number>`count(*)` }).from(positions).where(sql`closed_at IS NOT NULL`),
    ) ?? 0;

  const protocolCounts = db
    .select({ protocol: positions.protocol, open: sql<number>`count(*)` })
    .from(positions)
    .where(isNull(positions.closedAt))
    .groupBy(positions.protocol)
    .all();

  const eventsByChain = countEventsByChain(db);
  const totalEvents = eventsByChain.reduce((s, r) => s + r.count, 0);

  const unclassifiedOpen =
    scalar(db.select({ n: sql<number>`count(*)` }).from(unclassified).where(isNull(unclassified.resolvedAt))) ?? 0;
  const pendingLinks =
    scalar(
      db.select({ n: sql<number>`count(*)` }).from(transferLinks).where(eq(transferLinks.status, 'pending')),
    ) ?? 0;
  const lastIngestAt = scalar(db.select({ n: sql<number>`max(${rawTxs.fetchedAt})` }).from(rawTxs));
  const lastEventAt = scalar(db.select({ n: sql<number>`max(${events.timestamp})` }).from(events));

  // Harvested-to-date EUR across open positions (lenient lower-bound estimate).
  const open = await decoratePositions(openRows);
  const harvestedEur = open.reduce<number | null>((acc, p) => {
    if (p.harvestedEur === null) return acc;
    return (acc ?? 0) + p.harvestedEur;
  }, null);

  const recent = await decorateActivity(recentActivity(db, { limit: 8 }));

  return {
    openPositions: openRows.length,
    closedPositions: closedCount,
    eventsByChain,
    totalEvents,
    unclassifiedOpen,
    pendingLinks,
    lastIngestAt,
    lastEventAt,
    protocols: protocolCounts.sort((a, b) => b.open - a.open),
    harvestedEur,
    recent,
  };
}
