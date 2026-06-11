import { aliasedTable, and, eq, or } from 'drizzle-orm';
import { events, transferLinks } from '../../db/schema';
import type { Db } from '../db/client';
import type { EventRow } from '../db/repos/events';

export type TransferLinkInsert = typeof transferLinks.$inferInsert;
export type TransferLinkRow = typeof transferLinks.$inferSelect;

/**
 * Every event id that already participates in any link, regardless of status.
 * Re-runs of the linker skip these, which (a) makes `link` idempotent and
 * (b) preserves manual TUI decisions — a 'rejected' link keeps its events out
 * of automatic re-matching.
 */
export function linkedEventIds(db: Db): Set<number> {
  const rows = db
    .select({ outEventId: transferLinks.outEventId, inEventId: transferLinks.inEventId })
    .from(transferLinks)
    .all();
  const ids = new Set<number>();
  for (const r of rows) {
    ids.add(r.outEventId);
    ids.add(r.inEventId);
  }
  return ids;
}

export interface LinkWithEvents {
  link: TransferLinkRow;
  outEvent: EventRow;
  inEvent: EventRow;
}

/**
 * Tax-engine query shape (German FIFO, BMF 2025-03-06 Rz 62/103): own-wallet
 * transfers are NOT disposals — they move FIFO lots between per-wallet pools
 * with their acquisition date and cost basis carried forward.
 *
 * For a given (asset, wallet) pool the future tax engine asks:
 *   - lots LEAVING the pool:  links where outEvent.wallet = wallet and
 *     outEvent.sentAsset = asset → remove the lot at outEvent.timestamp.
 *   - lots ARRIVING in the pool: links where inEvent.wallet = wallet and
 *     inEvent.receivedAsset = asset → insert the carried-forward lot.
 *
 * Both directions are returned in one call; the caller partitions by
 * comparing `wallet` against outEvent.wallet / inEvent.wallet. Only
 * 'confirmed' links are basis-moving by default; pass `status` to inspect
 * pending ones.
 *
 * Note: `asset` is the chain-local id as stored on the events. For
 * cross-chain links the two sides may carry different ids for the same
 * canonical asset (e.g. base 'WETH' vs a solana mint) — the OR over both
 * sides handles that, matching whichever side belongs to `wallet`.
 */
export function listLinksForAssetWallet(
  db: Db,
  opts: { asset: string; wallet: string; status?: TransferLinkRow['status'] },
): LinkWithEvents[] {
  const outEvent = aliasedTable(events, 'out_event');
  const inEvent = aliasedTable(events, 'in_event');
  const rows = db
    .select({ link: transferLinks, outEvent, inEvent })
    .from(transferLinks)
    .innerJoin(outEvent, eq(outEvent.id, transferLinks.outEventId))
    .innerJoin(inEvent, eq(inEvent.id, transferLinks.inEventId))
    .where(
      and(
        eq(transferLinks.status, opts.status ?? 'confirmed'),
        or(
          and(eq(outEvent.wallet, opts.wallet), eq(outEvent.sentAsset, opts.asset)),
          and(eq(inEvent.wallet, opts.wallet), eq(inEvent.receivedAsset, opts.asset)),
        ),
      ),
    )
    .all();
  return rows;
}
