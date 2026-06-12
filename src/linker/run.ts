import { eq, inArray, and } from 'drizzle-orm';
import { events, transferLinks } from '../../db/schema';
import { kindForHeuristic, matchTransfers, type LinkMatch, type TransferLeg } from './match';
import { linkedEventIds } from './repo';
import type { Db } from '../db/client';
import type { Chain, Flag } from '../types/event';

export interface LinkRunSummary {
  /** Unlinked transfer:send legs considered. */
  outs: number;
  /** Unlinked transfer:receive legs considered. */
  ins: number;
  /** Events skipped because they already participate in a link. */
  alreadyLinked: number;
  matches: LinkMatch[];
  /** transfer_links rows written (0 on dry runs). */
  written: number;
}

/**
 * Post-decode linking pass ([1D.2] + issue #11): load unlinked
 * transfer:send / transfer:receive events, match them (same-chain
 * self-transfers + cross-chain bridges), persist `transfer_links` rows and
 * tag the linked events.
 *
 * Tagging is non-destructive for bridges (flags `bridge_out` / `bridge_in`
 * appended, subtype untouched). Same-chain self-transfers are retagged to
 * `transfer:self_transfer` + flag `self_transfer` per issue #11 — direction
 * stays recoverable from which amount column is populated.
 */
export function runLinker(db: Db, opts: { dryRun?: boolean } = {}): LinkRunSummary {
  const rows = db
    .select()
    .from(events)
    .where(and(eq(events.type, 'transfer'), inArray(events.subtype, ['send', 'receive'])))
    .all();

  const linked = linkedEventIds(db);
  let alreadyLinked = 0;
  const outs: TransferLeg[] = [];
  const ins: TransferLeg[] = [];
  for (const row of rows) {
    if (linked.has(row.id)) {
      alreadyLinked += 1;
      continue;
    }
    const isSend = row.subtype === 'send';
    const asset = isSend ? row.sentAsset : row.receivedAsset;
    const amount = isSend ? row.sentAmount : row.receivedAmount;
    if (asset === null || asset === undefined || amount === null || amount === undefined) continue;
    (isSend ? outs : ins).push({
      eventId: row.id,
      chain: row.chain as Chain,
      wallet: row.wallet,
      txHash: row.txHash,
      timestamp: row.timestamp,
      asset,
      amount,
    });
  }

  const matches = matchTransfers(outs, ins);
  const summary: LinkRunSummary = {
    outs: outs.length,
    ins: ins.length,
    alreadyLinked,
    matches,
    written: 0,
  };
  if (opts.dryRun === true || matches.length === 0) return summary;

  // Single short transaction: link rows + event tagging together.
  db.transaction((tx) => {
    for (const m of matches) {
      tx.insert(transferLinks)
        .values({
          outEventId: m.outEventId,
          inEventId: m.inEventId,
          confidence: m.confidence,
          status: m.status,
          heuristic: m.heuristic,
        })
        .run();
      applyLinkTags(tx, m);
    }
  });
  summary.written = matches.length;
  return summary;
}

export type LinkerDbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Tag the two events of one link from its heuristic — the ONE place the
 * heuristic → tag policy lives (bridges: non-destructive `bridge_out` /
 * `bridge_in` flags; self-transfers: retag to `transfer:self_transfer` +
 * flag). Used by `runLinker` at link time and by the decoder's
 * `reapplyLinkerTags` after a re-decode refreshes the event rows.
 */
export function applyLinkTags(
  tx: LinkerDbTx,
  link: { outEventId: number; inEventId: number; heuristic: string },
): void {
  if (kindForHeuristic(link.heuristic) === 'bridge') {
    tagEvent(tx, link.outEventId, 'bridge_out');
    tagEvent(tx, link.inEventId, 'bridge_in');
  } else {
    tagEvent(tx, link.outEventId, 'self_transfer', 'self_transfer');
    tagEvent(tx, link.inEventId, 'self_transfer', 'self_transfer');
  }
}

/** Append a flag (deduplicated) and optionally retag the subtype. */
function tagEvent(tx: LinkerDbTx, eventId: number, flag: Flag, subtype?: 'self_transfer'): void {
  const row = tx
    .select({ flagsJson: events.flagsJson })
    .from(events)
    .where(eq(events.id, eventId))
    .get();
  const flags = [...new Set([...(row?.flagsJson ?? []), flag])];
  tx.update(events)
    .set(subtype !== undefined ? { flagsJson: flags, subtype } : { flagsJson: flags })
    .where(eq(events.id, eventId))
    .run();
}
