import { Command } from 'commander';
import { openDb } from '../db/client';
import { runLinker } from './run';

/**
 * `link` subcommand. Wire into the root CLI with:
 *   program.addCommand(linkCommand());
 *
 * Privacy: the summary prints counts and heuristics only — never wallet
 * addresses.
 */
export function linkCommand(): Command {
  const link = new Command('link')
    .description(
      'Link own-wallet transfers: same-chain self-transfers (issue #11) + ' +
        'cross-chain bridges ([1D.2]) → transfer_links (idempotent)',
    )
    .option('--dry-run', 'report matches without writing links or flags')
    .action((opts: { dryRun?: boolean }) => {
      const client = openDb();
      try {
        const summary = runLinker(client.db, { dryRun: opts.dryRun });
        const byStatus = { confirmed: 0, pending: 0 };
        const byKind = { self_transfer: 0, bridge: 0 };
        for (const m of summary.matches) {
          byStatus[m.status] += 1;
          byKind[m.kind] += 1;
        }
        console.log(
          `link${opts.dryRun === true ? ' (dry run)' : ''}: ` +
            `${summary.outs} sends × ${summary.ins} receives considered ` +
            `(${summary.alreadyLinked} already linked) → ` +
            `${summary.matches.length} matches ` +
            `(${byKind.self_transfer} self-transfer, ${byKind.bridge} bridge; ` +
            `${byStatus.confirmed} confirmed, ${byStatus.pending} pending), ` +
            `${summary.written} links written`,
        );
      } finally {
        client.close();
      }
    });
  return link;
}
