/**
 * Shared Sui raw-tx plumbing for the Sui protocol handlers (navi, suilend,
 * turbos). A Sui tx is one ProgrammableTransactionBlock; handlers decode the
 * `events` array of the SuiTransactionBlockResponse stored by the [1C.2]
 * ingest (`logIndex` = index in that array) and attribute everything to the
 * PTB sender.
 */

/** One entry of SuiTransactionBlockResponse.events. */
export interface SuiEventShape {
  type?: string;
  parsedJson?: unknown;
}

interface SuiRawJsonShape {
  transaction?: { data?: { sender?: string } } | null;
  events?: readonly SuiEventShape[] | null;
}

/** The tx's Move events, in emission order. Empty for malformed payloads. */
export function suiEvents(rawJson: unknown): readonly SuiEventShape[] {
  const events = (rawJson as SuiRawJsonShape | null)?.events;
  return Array.isArray(events) ? events : [];
}

/** PTB sender — owns every action in the block. */
export function ptbSender(rawJson: unknown): string | undefined {
  return (rawJson as SuiRawJsonShape | null)?.transaction?.data?.sender;
}

/**
 * Guard against silently dropped foreign-protocol disposals: an owned PTB
 * containing a swap-shaped event the calling handler does not recognize
 * (e.g. a Cetus pool::SwapEvent disposing withdrawn collateral) must not be
 * marked 'decoded' on the handler's partial view — returning kind:'ok' would
 * silently drop a §23-relevant disposal. Until a Cetus/generic Sui swap rule
 * lands, such txs go to the manual queue. (Conservative: an aggregator
 * summary that a LATER handler would claim also trips this — manual review,
 * never loss.)
 *
 * Returns one problem string per unrecognized swap-shaped event.
 */
export function foreignSwapProblems(
  events: readonly SuiEventShape[],
  isHandledType: (type: string) => boolean,
): string[] {
  const problems: string[] = [];
  for (const [index, event] of events.entries()) {
    const type = event.type ?? '';
    if (type === '' || isHandledType(type)) continue;
    const structName = type.split('<')[0]!.split('::').pop() ?? '';
    if (/swap/i.test(structName)) {
      problems.push(
        `unrecognized swap leg '${type.split('<')[0]}' at event index ${index} in an owned ` +
          'PTB — foreign-protocol disposal, label manually (no Cetus/generic Sui swap handler yet)',
      );
    }
  }
  return problems;
}
