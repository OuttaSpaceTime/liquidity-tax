#!/usr/bin/env bun
import { Command } from 'commander';
import { createDefaultRegistry } from './decoder';
import { pricesCommand } from './prices/cli';
import { backfillPrices } from './prices/backfill';
import { CoinGeckoClient } from './prices/coingecko';
import { DefiLlamaClient } from './prices/defillama';
import { linkCommand } from './linker/cli';
import { runLinker } from './linker/run';
import { rebuildAllPositions } from './positions';
import { createDefaultChainRegistry } from './chains/registry';
import { loadWallets, walletsFor, type Wallet } from './config/wallets-loader';
import { env, requireEnv } from './config/env';
import { redactSecrets } from './config/redact';
import type { Db } from './db/client';
import { openDb } from './db/client';
import { countRawTxsByChain, listRawTxKeys } from './db/repos/raw-txs';
import { countEventsByChain } from './db/repos/events';
import { countUnclassifiedByChain } from './db/repos/unclassified';
import type { Chain } from './types/event';

const CHAINS: readonly Chain[] = ['base', 'solana', 'sui'];

/** Key values to scrub from any error/log text (viem embeds the RPC URL — with the key — in errors). */
const SECRETS: ReadonlyArray<string | undefined> = [
  env.ALCHEMY_API_KEY,
  env.HELIUS_API_KEY,
  env.COINGECKO_API_KEY,
];

function parseChain(value: string): Chain {
  if ((CHAINS as readonly string[]).includes(value)) return value as Chain;
  throw new Error(`Unknown chain '${value}' — expected one of: ${CHAINS.join(', ')}`);
}

function formatCounts(rows: Array<{ chain: string; count: number }>): string {
  if (rows.length === 0) return '(empty)';
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return rows.map((r) => `${r.chain}=${r.count}`).join('  ') + `  (total ${total})`;
}

const program = new Command();
program
  .name('liquidity-tax')
  .description('DeFi tax-decoder CLI (ingest → decode → link → prices)');

/**
 * Fetch raw txs for the given wallets into `raw_txs`. Logs labels only (never
 * addresses). Shared by the `ingest` and `refresh` commands.
 */
async function ingestStage(
  db: Db,
  chain: Chain,
  wallets: Wallet[],
  opts: { full?: boolean } = {},
): Promise<void> {
  const adapter = createDefaultChainRegistry().get(chain);
  if (adapter === undefined) {
    // Unreachable: createDefaultChainRegistry registers all three chains.
    throw new Error(`No ingest adapter registered for chain '${chain}'.`);
  }
  // Privacy: log wallet labels only, never addresses.
  console.log(`ingest ${chain}: wallets [${wallets.map((w) => w.label).join(', ')}]`);
  const result = await adapter.ingest(wallets, { db, full: opts.full });
  console.log(`fetched ${result.fetched} txs, upserted ${result.upserted} raw_txs rows`);
}

/**
 * Run the three-phase decoder over `raw_txs` and rebuild positions. Shared by
 * the `decode` and `refresh` commands. Decodes against all wallets (archived
 * included) since historical txs still decode.
 */
async function decodeStage(db: Db, chain?: Chain): Promise<void> {
  const allWallets = await loadWallets();
  const walletsByChain: Partial<Record<Chain, string[]>> = {};
  for (const w of allWallets) (walletsByChain[w.chain] ??= []).push(w.address);

  const registry = createDefaultRegistry(db, { wallets: walletsByChain });
  const keys = listRawTxKeys(db, chain);
  const tally = { decoded: 0, skipped: 0, unclassified: 0, events: 0 };
  for (const key of keys) {
    const result = registry.decodeAndPersist(key.chain as Chain, key.txHash);
    tally[result.status] += 1;
    if (result.status === 'decoded') tally.events += result.events.length;
  }
  console.log(
    `decode${chain !== undefined ? ` ${chain}` : ''}: ${keys.length} txs → ` +
      `${tally.decoded} decoded (${tally.events} events), ` +
      `${tally.skipped} skipped, ${tally.unclassified} unclassified`,
  );
  const rebuilt = rebuildAllPositions(db);
  console.log(`positions: ${rebuilt.upserted} rebuilt, ${rebuilt.deleted} stale removed`);
}

program
  .command('ingest')
  .description('Fetch raw on-chain txs for configured wallets into raw_txs (idempotent)')
  .requiredOption('--chain <chain>', `chain to ingest: ${CHAINS.join(' | ')}`, parseChain)
  .option('--label <label>', 'restrict to one wallet label')
  .option('--address <address>', 'restrict to one wallet address')
  .option('--full', 're-enumerate from genesis (Base only; ignores the block watermark)')
  .action(async (opts: { chain: Chain; label?: string; address?: string; full?: boolean }) => {
    let wallets = await walletsFor(opts.chain, 'active');
    if (opts.label !== undefined) wallets = wallets.filter((w) => w.label === opts.label);
    if (opts.address !== undefined) wallets = wallets.filter((w) => w.address === opts.address);
    if (wallets.length === 0) {
      program.error(`No active ${opts.chain} wallets match the given filter.`);
    }

    const client = openDb();
    try {
      await ingestStage(client.db, opts.chain, wallets, { full: opts.full });
    } finally {
      client.close();
    }
  });

program
  .command('decode')
  .description('Run the three-phase decoder over raw_txs and persist events (idempotent)')
  .option('--chain <chain>', `restrict to one chain: ${CHAINS.join(' | ')}`, parseChain)
  .action(async (opts: { chain?: Chain }) => {
    const client = openDb();
    try {
      await decodeStage(client.db, opts.chain);
    } finally {
      client.close();
    }
  });

program
  .command('refresh')
  .description('Run the full pipeline end-to-end: ingest → decode → link → prices (idempotent)')
  .option('--chain <chain>', `restrict ingest+decode to one chain: ${CHAINS.join(' | ')}`, parseChain)
  .option('--max-calls <n>', 'cap on outbound price-API calls for this run', '500')
  .action(async (opts: { chain?: Chain; maxCalls: string }) => {
    const maxCalls = Number.parseInt(opts.maxCalls, 10);
    if (!Number.isFinite(maxCalls) || maxCalls <= 0) {
      program.error(`--max-calls must be a positive integer, got '${opts.maxCalls}'`);
    }
    // Fast-fail the stage-4 precondition up front, before any expensive ingest.
    if (env.COINGECKO_API_KEY == null) {
      program.error(
        'refresh needs COINGECKO_API_KEY for the prices stage — ' +
          'run `ingest`/`decode`/`link` separately if you only want those.',
      );
    }

    const client = openDb();
    try {
      // Stage 1 — ingest active wallets, per chain. A failure on one chain
      // (e.g. a transient RPC error or a missing key) is logged and skipped so
      // decode/link/prices still run over whatever ingested successfully.
      const chains = opts.chain !== undefined ? [opts.chain] : [...CHAINS];
      for (const chain of chains) {
        const wallets = await walletsFor(chain, 'active');
        if (wallets.length === 0) {
          console.log(`ingest ${chain}: no active wallets — skipped`);
          continue;
        }
        try {
          await ingestStage(client.db, chain, wallets);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.log(
            `ingest ${chain}: failed — ${redactSecrets(msg, SECRETS)} ` +
              `(continuing; later stages still run)`,
          );
        }
      }

      // Stage 2 — decode + rebuild positions.
      await decodeStage(client.db, opts.chain);

      // Stage 3 — link own-wallet transfers.
      const link = runLinker(client.db);
      console.log(`link: ${link.matches.length} matches, ${link.written} links written`);

      // Stage 4 — backfill EUR+USD prices.
      const prices = await backfillPrices(
        client.db,
        { maxCalls },
        {
          coingecko: new CoinGeckoClient({ apiKey: requireEnv('COINGECKO_API_KEY') }),
          defillama: new DefiLlamaClient(),
          log: (msg) => console.log(msg),
        },
      );
      console.log(
        `prices: ${prices.neededPairs} pairs needed → ${prices.written} rows written ` +
          `(${prices.coingeckoCalls} coingecko + ${prices.defillamaCalls} defillama calls, ` +
          `${prices.stopped})`,
      );
    } finally {
      client.close();
    }
  });

program.addCommand(pricesCommand());
program.addCommand(linkCommand());

program
  .command('status')
  .description('Row counts per table and chain')
  .action(() => {
    const client = openDb();
    try {
      console.log('raw_txs       ', formatCounts(countRawTxsByChain(client.db)));
      console.log('events        ', formatCounts(countEventsByChain(client.db)));
      console.log('unclassified  ', formatCounts(countUnclassifiedByChain(client.db)));
      for (const table of ['positions', 'prices', 'rules', 'transfer_links'] as const) {
        const row = client.sqlite
          .query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
          .get();
        console.log(`${table.padEnd(14)} (total ${row?.count ?? 0})`);
      }
    } finally {
      client.close();
    }
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  // Last-resort scrub: viem (and others) put the full RPC URL — including the
  // API key — into thrown error messages and stacks. Never let that reach stderr.
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(redactSecrets(text, SECRETS));
  process.exit(1);
}
