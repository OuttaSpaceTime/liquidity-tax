#!/usr/bin/env bun
import { Command } from 'commander';
import { createDefaultRegistry } from './decoder';
import { pricesCommand } from './prices/cli';
import { createDefaultChainRegistry } from './chains/registry';
import { loadWallets, walletsFor } from './config/wallets-loader';
import { openDb } from './db/client';
import { countRawTxsByChain, listRawTxKeys } from './db/repos/raw-txs';
import { countEventsByChain } from './db/repos/events';
import { countUnclassifiedByChain } from './db/repos/unclassified';
import type { Chain } from './types/event';

const CHAINS: readonly Chain[] = ['base', 'solana', 'sui'];

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
program.name('liquidity-tax').description('DeFi tax-decoder CLI (ingest → decode → export)');

program
  .command('ingest')
  .description('Fetch raw on-chain txs for configured wallets into raw_txs (idempotent)')
  .requiredOption('--chain <chain>', `chain to ingest: ${CHAINS.join(' | ')}`, parseChain)
  .option('--label <label>', 'restrict to one wallet label')
  .option('--address <address>', 'restrict to one wallet address')
  .action(async (opts: { chain: Chain; label?: string; address?: string }) => {
    let wallets = await walletsFor(opts.chain, 'active');
    if (opts.label !== undefined) wallets = wallets.filter((w) => w.label === opts.label);
    if (opts.address !== undefined) wallets = wallets.filter((w) => w.address === opts.address);
    if (wallets.length === 0) {
      program.error(`No active ${opts.chain} wallets match the given filter.`);
    }

    const adapter = createDefaultChainRegistry().get(opts.chain);
    if (adapter === undefined) {
      program.error(
        `No ingest adapter registered for chain '${opts.chain}' yet — lands with phase 1A/1B/1C.`,
      );
      return;
    }

    const client = openDb();
    try {
      // Privacy: log wallet labels only, never addresses.
      console.log(`ingest ${opts.chain}: wallets [${wallets.map((w) => w.label).join(', ')}]`);
      const result = await adapter.ingest(wallets, { db: client.db });
      console.log(`fetched ${result.fetched} txs, upserted ${result.upserted} raw_txs rows`);
    } finally {
      client.close();
    }
  });

program
  .command('decode')
  .description('Run the three-phase decoder over raw_txs and persist events (idempotent)')
  .option('--chain <chain>', `restrict to one chain: ${CHAINS.join(' | ')}`, parseChain)
  .action(async (opts: { chain?: Chain }) => {
    const allWallets = await loadWallets(); // archived included: historical txs still decode
    const walletsByChain: Partial<Record<Chain, string[]>> = {};
    for (const w of allWallets) (walletsByChain[w.chain] ??= []).push(w.address);

    const client = openDb();
    try {
      const registry = createDefaultRegistry(client.db, { wallets: walletsByChain });
      const keys = listRawTxKeys(client.db, opts.chain);
      const tally = { decoded: 0, skipped: 0, unclassified: 0, events: 0 };
      for (const key of keys) {
        const result = registry.decodeAndPersist(key.chain as Chain, key.txHash);
        tally[result.status] += 1;
        if (result.status === 'decoded') tally.events += result.events.length;
      }
      console.log(
        `decode${opts.chain !== undefined ? ` ${opts.chain}` : ''}: ${keys.length} txs → ` +
          `${tally.decoded} decoded (${tally.events} events), ` +
          `${tally.skipped} skipped, ${tally.unclassified} unclassified`,
      );
    } finally {
      client.close();
    }
  });

program.addCommand(pricesCommand());

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

await program.parseAsync(process.argv);
