/**
 * validate-blockpit.ts — cross-check decoded `events` against the owner's
 * existing Blockpit export (liquidity-sheets/Transactions.csv, READ-ONLY).
 *
 * Run:  bun scripts/validate-blockpit.ts [--csv <path>] [--corrected <path>] > report-body.md
 *
 * What it does (see .claude/docs/planning/08-pipeline-validation-20260610.md
 * for the interpreted results):
 *   1. joins Blockpit rows ↔ DB events on Trx. ID (tx hash / digest); rows
 *      without a Trx. ID fall back to a (timestamp ±2 min, asset, amount)
 *      heuristic.
 *   2. coverage both directions per chain against SOURCE A (the raw export),
 *      with known-out-of-scope rows (Bitvavo/CEX, Ethereum/Polygon chains,
 *      Manual, Cetus + other foreign-protocol Sui txs) counted separately.
 *   3. classification agreement against SOURCE B (the corrected tax-report
 *      output, authoritative for labels) via EXPECTED_LABELS_CORRECTED, with
 *      synthetic injected rows (Trx. ID `lp-…`) counted as known-synthetic
 *      and every disagreement marked residual (B label == raw label, i.e.
 *      never corrected) vs deliberate. A raw-label comparison against source
 *      A via EXPECTED_LABELS is kept for reference.
 *   4. amount agreement on a deterministic sample of 50 matched legs.
 *
 * Privacy: never selects or prints wallet addresses; only tx hashes/digests.
 */

import { openDb } from '../src/db/client';

// ---------------------------------------------------------------------------
// CSV parsing (Blockpit export: semicolon-separated, CRLF, quoted fields)
// ---------------------------------------------------------------------------

interface CsvRow {
  line: number;
  ts: number; // epoch seconds, UTC
  integration: string;
  label: string;
  outAsset: string;
  outAmount: number | null;
  inAsset: string;
  inAmount: number | null;
  feeAsset: string;
  feeAmount: number | null;
  comment: string;
  txId: string;
  sourceType: string;
  sourceName: string;
}

function splitSemicolon(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ';') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/** "1.234,56" / "1234.56" / "1234,56" → number; '' → null. */
function parseAmount(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  let normalized = t;
  if (t.includes(',') && t.includes('.')) {
    normalized =
      t.lastIndexOf(',') > t.lastIndexOf('.')
        ? t.replace(/\./g, '').replace(',', '.') // 1.234,56
        : t.replace(/,/g, ''); // 1,234.56
  } else if (t.includes(',')) {
    normalized = t.replace(',', '.'); // decimal comma
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** "DD.MM.YYYY HH:MM:SS" (UTC) → epoch seconds. */
function parseDateUtc(s: string): number {
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) throw new Error(`unparseable date: ${s}`);
  return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]) / 1000;
}

async function readCsv(path: string): Promise<CsvRow[]> {
  const text = await Bun.file(path).text();
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const f = splitSemicolon(lines[i]);
    rows.push({
      line: i + 1,
      ts: parseDateUtc(f[0]),
      integration: f[1],
      label: f[2],
      outAsset: f[3].trim(),
      outAmount: parseAmount(f[4]),
      inAsset: f[5].trim(),
      inAmount: parseAmount(f[6]),
      feeAsset: f[7]?.trim() ?? '',
      feeAmount: parseAmount(f[8] ?? ''),
      comment: f[9]?.trim() ?? '',
      txId: f[10]?.trim() ?? '',
      sourceType: f[11]?.trim() ?? '',
      sourceName: f[12]?.trim() ?? '',
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Asset normalization: event asset id → Blockpit-style symbol (+ decimals)
// ---------------------------------------------------------------------------

type Chain = 'base' | 'solana' | 'sui';

/** Event asset id → CSV symbol. Unmapped ids pass through verbatim. */
const SYMBOL_MAP: Record<string, string> = {
  // solana mints (handlers emit raw mints)
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 'JITOSOL',
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: 'ORCA',
  pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn: 'PUMP',
  CRTx1JouZhzSU6XytsE42UQraoGqiHgxabocVfARTy2s: 'CRT',
  HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC: 'AI16Z',
  '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4': 'JLP',
  '3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC': 'EUSX',
  '6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG': 'USX',
  // base ERC-20 addresses (lowercase, as emitted)
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI',
  '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42': 'EURC',
  '0x35e5db674d8e93a03d814fa0ada70731efe8a4b9': 'USR',
  // sui coin types
  '0x3a304c7feba2d819ea57c3542d68439ca2c386ba02159c740f7b406e592c62ea::haedal::HAEDAL': 'HAEDAL',
  '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA': 'IKA',
};

/**
 * Confident decimals only (chain conventions / verified token configs).
 * Everything else is INFERRED from matched (raw, csv) amount pairs and the
 * inference table is printed so wrong guesses are visible, not silent.
 */
const KNOWN_DECIMALS: Record<string, number> = {
  'base:ETH': 18,
  'base:WETH': 18,
  'base:USDC': 6,
  'base:USDT': 6,
  'base:cbBTC': 8,
  'base:AERO': 18,
  'base:VIRTUAL': 18,
  'base:DAI': 18,
  'base:EURC': 6,
  'base:USR': 18,
  'solana:SOL': 9,
  'solana:USDC': 6,
  'solana:USDT': 6,
  'solana:JITOSOL': 9,
  'solana:ORCA': 6,
  'solana:JLP': 6,
  'sui:SUI': 9,
  'sui:USDC': 6,
  'sui:USDT': 6,
  'sui:DEEP': 6,
  'sui:WAL': 9,
  'sui:NAVX': 9,
  'sui:CETUS': 9,
  'sui:vSUI': 9,
  'sui:sSUI': 9,
  'sui:haSUI': 9,
  'sui:IKA': 9, // verified via suix_getCoinMetadata 2026-06-11
};

/** Symbols treated as interchangeable when pairing legs (1:1 wrappers). */
const SYMBOL_GROUPS: string[][] = [
  ['ETH', 'WETH'],
  ['SOL', 'WSOL'],
];
function groupOf(symbol: string): string {
  const g = SYMBOL_GROUPS.find((grp) => grp.includes(symbol));
  return g ? g[0] : symbol;
}

// ---------------------------------------------------------------------------
// Classification mapping: our (type, subtype, direction) → Blockpit labels
// ---------------------------------------------------------------------------

/**
 * `agree`: Blockpit label is consistent with our classification.
 * Blockpit's vocabulary is poorer than ours (no LP semantics): both its
 * `Deposit`/`Withdrawal` are bare transfer labels, so for LP/lending flows
 * "agreement" means "Blockpit recorded the same asset flow direction".
 * A swap leg labeled Deposit/Withdrawal with a `Fallback` comment is counted
 * separately as `their-fallback` (Blockpit failed to decode the swap).
 */
const EXPECTED_LABELS: Record<string, string[]> = {
  'swap:trade:out': ['Trade'],
  'swap:trade:in': ['Trade'],
  'transfer:wrap:out': ['Trade'],
  'transfer:wrap:in': ['Trade'],
  'transfer:unwrap:out': ['Trade'],
  'transfer:unwrap:in': ['Trade'],
  'transfer:send:out': ['Withdrawal'],
  'lp_deposit:add_liquidity:out': ['Withdrawal'],
  // open_position carries the initial token deposit (sent legs); close_position
  // carries the final token withdrawal (received legs).
  'lp_deposit:open_position:out': ['Withdrawal'],
  'lp_deposit:open_position:in': ['Non-Taxable In', 'Deposit'],
  'lp_withdraw:remove_liquidity:in': ['Deposit'],
  'lp_withdraw:close_position:in': ['Deposit'],
  'lp_withdraw:close_position:out': ['Withdrawal', 'Non-Taxable Out'],
  'lp_fee:collect:in': ['Deposit', 'Reward'],
  'lp_reward:gauge_claim:in': ['Deposit', 'Reward', 'Airdrop', 'Income'],
  'lp_reward:emission_claim:in': ['Deposit', 'Reward', 'Airdrop', 'Income'],
  'lend_supply:deposit:out': ['Withdrawal'],
  'lend_supply:withdraw:in': ['Deposit'],
  'lend_reward:claim:in': ['Deposit', 'Reward', 'Airdrop', 'Income'],
  'lend_borrow:borrow:in': ['Deposit'],
  'lend_borrow:repay:out': ['Withdrawal'],
};

/**
 * Source B expectations: the owner's CORRECTED pipeline output
 * (tax-report-2025/04d-lp-positions/Transactions_with_lp_corrections.csv) is
 * the classification source of truth. Its conventions (verified against the
 * generating scripts under liquidity-sheets/tax-report-2025/):
 *   - LP add/remove legs and position-NFT legs → Non-Taxable Out / In
 *     (basis carry-forward — matches our locked LP-deposit tax policy);
 *   - lending supply/withdraw/borrow/repay     → Non-Taxable Out / In;
 *   - LP fees + incentive claims                → Reward (synthetic LP_FEE rows
 *     carry Trx. IDs like `lp-<pos>-fee-t0` — no on-chain tx, counted as
 *     known-synthetic);
 *   - swaps                                     → Trade;
 *   - plain transfers                           → Withdrawal / Deposit or
 *     Non-Taxable Out/In (self-transfers).
 */
const EXPECTED_LABELS_CORRECTED: Record<string, string[]> = {
  'swap:trade:out': ['Trade'],
  'swap:trade:in': ['Trade'],
  'transfer:wrap:out': ['Trade', 'Non-Taxable Out'],
  'transfer:wrap:in': ['Trade', 'Non-Taxable In'],
  'transfer:unwrap:out': ['Trade', 'Non-Taxable Out'],
  'transfer:unwrap:in': ['Trade', 'Non-Taxable In'],
  'transfer:send:out': ['Withdrawal', 'Non-Taxable Out'],
  'lp_deposit:add_liquidity:out': ['Non-Taxable Out'],
  'lp_deposit:open_position:out': ['Non-Taxable Out'],
  'lp_deposit:open_position:in': ['Non-Taxable In'],
  'lp_withdraw:remove_liquidity:in': ['Non-Taxable In'],
  'lp_withdraw:close_position:in': ['Non-Taxable In'],
  'lp_withdraw:close_position:out': ['Non-Taxable Out'],
  'lp_fee:collect:in': ['Reward'],
  'lp_reward:gauge_claim:in': ['Reward', 'Airdrop'],
  'lp_reward:emission_claim:in': ['Reward', 'Airdrop'],
  'lend_supply:deposit:out': ['Non-Taxable Out'],
  'lend_supply:withdraw:in': ['Non-Taxable In'],
  'lend_reward:claim:in': ['Reward', 'Airdrop', 'Income'],
  'lend_borrow:borrow:in': ['Non-Taxable In'],
  'lend_borrow:repay:out': ['Non-Taxable Out'],
};

// ---------------------------------------------------------------------------
// Out-of-scope protocol detection (Sui txs Blockpit covers but we deliberately
// don't decode — no Cetus/foreign-DEX handler). Detected via package ids in
// the ingested raw tx JSON. "MAD Finance" / "AMMD" (Blockpit UI names) have
// no on-chain identifier we could match by name; unidentified DEX packages
// are listed by package id so they can be attributed manually.
// ---------------------------------------------------------------------------

const OUT_OF_SCOPE_MARKERS: Record<string, string> = {
  '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb': 'Cetus CLMM',
  '0xeffc8ae61f439bb34c9b905ff8f29ec56873dcedf81c7123ff2f1f67c45ec302': 'Cetus (aggregator leg)',
  '::cetus::CETUS': 'CETUS coin',
  '0x25929e7f29e0a30eb4e692952ba1b5b65a3a4d65ab5f2a32e1ba3edcb587f26d':
    'unidentified Sui CLMM (0x2592…f26d)',
  '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860':
    'unidentified Sui CLMM (0x7028…b860)',
  '0xa0e3b011012b80af4957afa30e556486eb3da0a7d96eeb733cf16ccd3aec32e0':
    'unidentified Sui oracle-pool DEX (0xa0e3…32e0)',
  '0x17c0b1f7a6ad73f51268f16b8c06c049eecc2f28a270cdd29c06e3d2dea23302':
    'unidentified Sui settle/Swap (0x17c0…3302)',
  '0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267':
    'unidentified Sui AssetSwap (0x3492…9c267)',
};

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface EventRow {
  chain: Chain;
  txHash: string;
  ts: number;
  type: string;
  subtype: string;
  sentAsset: string | null;
  sentAmount: string | null; // raw integer as decimal string
  receivedAsset: string | null;
  receivedAmount: string | null;
}

interface EvLeg {
  chain: Chain;
  txHash: string;
  ts: number;
  dir: 'out' | 'in';
  assetId: string;
  symbol: string;
  raw: number; // raw integer amount (as float; fine for comparison)
  type: string;
  subtype: string;
  matched?: boolean;
}

const CSV_CHAIN: Record<string, Chain> = { Base: 'base', Solana: 'solana', Sui: 'sui' };

function evLegs(e: EventRow): EvLeg[] {
  const legs: EvLeg[] = [];
  if (e.sentAsset !== null && e.sentAmount !== null) {
    const symbol = SYMBOL_MAP[e.sentAsset] ?? e.sentAsset;
    legs.push({
      chain: e.chain,
      txHash: e.txHash,
      ts: e.ts,
      dir: 'out',
      assetId: e.sentAsset,
      symbol,
      raw: Number(e.sentAmount),
      type: e.type,
      subtype: e.subtype,
    });
  }
  if (e.receivedAsset !== null && e.receivedAmount !== null) {
    const symbol = SYMBOL_MAP[e.receivedAsset] ?? e.receivedAsset;
    legs.push({
      chain: e.chain,
      txHash: e.txHash,
      ts: e.ts,
      dir: 'in',
      assetId: e.receivedAsset,
      symbol,
      raw: Number(e.receivedAmount),
      type: e.type,
      subtype: e.subtype,
    });
  }
  return legs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const csvPathFlag = process.argv.indexOf('--csv');
const CSV_PATH =
  csvPathFlag >= 0
    ? process.argv[csvPathFlag + 1]
    : '/home/felix/Code/Misc/defi-tracker/liquidity-sheets/Transactions.csv';

const rows = await readCsv(CSV_PATH);
const { sqlite, close } = openDb();

const events = sqlite
  .query(
    `SELECT chain, tx_hash AS txHash, timestamp AS ts, type, subtype,
            sent_asset AS sentAsset, CAST(sent_amount AS TEXT) AS sentAmount,
            received_asset AS receivedAsset, CAST(received_amount AS TEXT) AS receivedAmount
     FROM events`,
  )
  .all() as EventRow[];

const rawTxSet = new Set(
  (sqlite.query(`SELECT chain || ':' || tx_hash AS k FROM raw_txs`).all() as { k: string }[]).map(
    (r) => r.k,
  ),
);
const unclassifiedReason = new Map(
  (
    sqlite.query(`SELECT chain || ':' || tx_hash AS k, reason FROM unclassified`).all() as {
      k: string;
      reason: string;
    }[]
  ).map((r) => [r.k, r.reason]),
);

function rawJsonFor(chain: Chain, txHash: string): string | null {
  const r = sqlite
    .query(`SELECT raw_json AS j FROM raw_txs WHERE chain = ? AND tx_hash = ?`)
    .get(chain, txHash) as { j: string } | null;
  return r?.j ?? null;
}

// --- scope partition --------------------------------------------------------

const excluded = { cex: 0, ethereum: 0, polygon: 0, manual: 0, otherSource: 0 };
const inScope: CsvRow[] = [];
for (const r of rows) {
  if (r.sourceType === 'API') excluded.cex++;
  else if (r.sourceType === 'Manual') excluded.manual++;
  else if (r.sourceName === 'Ethereum') excluded.ethereum++;
  else if (r.sourceName === 'Polygon') excluded.polygon++;
  else if (CSV_CHAIN[r.sourceName]) inScope.push(r);
  else excluded.otherSource++;
}

// group by tx
const csvByTx = new Map<string, CsvRow[]>();
const csvNoTxId: CsvRow[] = [];
for (const r of inScope) {
  if (r.txId === '') {
    csvNoTxId.push(r);
    continue;
  }
  const k = `${CSV_CHAIN[r.sourceName]}:${r.txId}`;
  csvByTx.set(k, [...(csvByTx.get(k) ?? []), r]);
}

const evByTx = new Map<string, EventRow[]>();
for (const e of events) {
  const k = `${e.chain}:${e.txHash}`;
  evByTx.set(k, [...(evByTx.get(k) ?? []), e]);
}

// out-of-scope protocol detection for CSV txs that produced no events
const protocolExcludedTxs = new Map<string, string>(); // txKey → protocol
for (const k of csvByTx.keys()) {
  if (evByTx.has(k)) continue;
  const [chain, txHash] = [k.slice(0, k.indexOf(':')) as Chain, k.slice(k.indexOf(':') + 1)];
  if (chain !== 'sui') continue; // Cetus & co. are Sui-side gaps
  const raw = rawJsonFor(chain, txHash);
  if (raw === null) continue;
  for (const [marker, name] of Object.entries(OUT_OF_SCOPE_MARKERS)) {
    if (raw.includes(marker)) {
      protocolExcludedTxs.set(k, name);
      break;
    }
  }
}

// --- tx-level coverage: CSV → DB --------------------------------------------

interface MissBucket {
  count: number;
  rows: number;
  examples: string[];
  labels: Map<string, number>;
}
function bump(map: Map<string, MissBucket>, key: string, txHash: string, txRows: CsvRow[]) {
  const b = map.get(key) ?? { count: 0, rows: 0, examples: [], labels: new Map() };
  b.count++;
  b.rows += txRows.length;
  if (b.examples.length < 3) b.examples.push(txHash);
  for (const r of txRows) b.labels.set(r.label, (b.labels.get(r.label) ?? 0) + 1);
  map.set(key, b);
}

const csvCovered = new Map<Chain, number>([
  ['base', 0],
  ['solana', 0],
  ['sui', 0],
]);
const csvTotal = new Map<Chain, number>([
  ['base', 0],
  ['solana', 0],
  ['sui', 0],
]);
const csvMisses = new Map<string, MissBucket>(); // `${chain}|${bucket}`
let protocolExcludedRowCount = 0;

for (const [k, txRows] of csvByTx) {
  const chain = k.slice(0, k.indexOf(':')) as Chain;
  const txHash = k.slice(k.indexOf(':') + 1);
  if (protocolExcludedTxs.has(k)) {
    protocolExcludedRowCount += txRows.length;
    continue; // counted separately, not a coverage miss
  }
  csvTotal.set(chain, (csvTotal.get(chain) ?? 0) + 1);
  if (evByTx.has(k)) {
    csvCovered.set(chain, (csvCovered.get(chain) ?? 0) + 1);
    continue;
  }
  const onlySpam = txRows.every((r) => r.label === 'Non-Taxable In');
  let bucket: string;
  if (!rawTxSet.has(k)) bucket = 'not ingested (missing from raw_txs)';
  else if (unclassifiedReason.has(k))
    bucket = onlySpam
      ? 'unclassified in DB — CSV says spam/dust airdrop (all rows Non-Taxable In)'
      : 'unclassified in DB (no handler matched)';
  else bucket = 'ingested + not unclassified, but no events (decoder skipped)';
  bump(csvMisses, `${chain}|${bucket}`, txHash, txRows);
}

// --- tx-level coverage: DB → CSV --------------------------------------------

const csvTsMin = Math.min(...inScope.map((r) => r.ts));
const csvTsMax = Math.max(...inScope.map((r) => r.ts));
const dbMisses = new Map<
  string,
  { count: number; examples: string[]; types: Map<string, number> }
>();
const dbCovered = new Map<Chain, number>();
const dbTotal = new Map<Chain, number>();

for (const [k, txEvents] of evByTx) {
  const chain = txEvents[0].chain;
  dbTotal.set(chain, (dbTotal.get(chain) ?? 0) + 1);
  if (csvByTx.has(k)) {
    dbCovered.set(chain, (dbCovered.get(chain) ?? 0) + 1);
    continue;
  }
  const ts = txEvents[0].ts;
  const outsideRange = ts < csvTsMin - 120 || ts > csvTsMax + 120;
  const gasOnly = txEvents.every((e) => e.type === 'gas');
  const bucket = outsideRange
    ? 'outside CSV date range'
    : gasOnly
      ? 'gas-only tx (Blockpit drops fee-only txs)'
      : 'in range, missing from CSV';
  const key = `${chain}|${bucket}`;
  const b = dbMisses.get(key) ?? { count: 0, examples: [], types: new Map() };
  b.count++;
  if (b.examples.length < 3) b.examples.push(k.slice(k.indexOf(':') + 1));
  for (const e of txEvents) {
    const t = `${e.type}:${e.subtype}`;
    b.types.set(t, (b.types.get(t) ?? 0) + 1);
  }
  dbMisses.set(key, b);
}

// --- leg/group matching on covered txs ---------------------------------------
//
// Granularity note: Blockpit aggregates flows per tx row, while our handlers
// emit one event per instruction — split-route swaps produce several event
// legs that sum to one Blockpit row. Amounts are therefore compared on
// (tx, direction, asset-group) SUMS; classification is paired greedily
// between the individual legs inside each matched group.

interface CsvGroupLeg {
  row: CsvRow;
  amount: number;
}
interface TxGroups {
  csv: Map<string, { sum: number; legs: CsvGroupLeg[]; symbol: string; dir: 'out' | 'in' }>;
  ev: Map<string, { rawSum: number; legs: EvLeg[]; symbol: string; dir: 'out' | 'in' }>;
}

function buildGroups(chain: Chain, txEvents: EventRow[], txRows: CsvRow[]): TxGroups {
  const csv: TxGroups['csv'] = new Map();
  for (const r of txRows) {
    const sides: Array<['out' | 'in', string, number | null]> = [
      ['out', r.outAsset, r.outAmount],
      ['in', r.inAsset, r.inAmount],
    ];
    for (const [dir, asset, amount] of sides) {
      if (asset === '' || amount === null) continue;
      const gk = `${dir}|${groupOf(asset).toUpperCase()}`;
      const g = csv.get(gk) ?? { sum: 0, legs: [], symbol: asset, dir };
      g.sum += amount;
      g.legs.push({ row: r, amount });
      csv.set(gk, g);
    }
  }
  const ev: TxGroups['ev'] = new Map();
  for (const l of txEvents.flatMap(evLegs)) {
    if (l.type === 'gas') continue;
    const gk = `${l.dir}|${groupOf(l.symbol).toUpperCase()}`;
    const g = ev.get(gk) ?? { rawSum: 0, legs: [], symbol: l.symbol, dir: l.dir };
    g.rawSum += l.raw;
    g.legs.push(l);
    ev.set(gk, g);
  }
  return { csv, ev };
}

const coveredTxs: Array<{ k: string; chain: Chain; txHash: string; groups: TxGroups }> = [];
for (const [k, txRows] of csvByTx) {
  const txEvents = evByTx.get(k);
  if (!txEvents) continue;
  const chain = CSV_CHAIN[txRows[0].sourceName];
  coveredTxs.push({
    k,
    chain,
    txHash: k.slice(k.indexOf(':') + 1),
    groups: buildGroups(chain, txEvents, txRows),
  });
}

// pass 1: decimals inference from group sums, for assets without KNOWN_DECIMALS
const inferencePairs = new Map<string, Array<{ raw: number; csv: number }>>();
const assetIdBySymbol = new Map<string, Set<string>>();
for (const t of coveredTxs) {
  for (const [gk, cg] of t.groups.csv) {
    const eg = t.groups.ev.get(gk);
    if (!eg || cg.sum <= 0 || eg.rawSum <= 0) continue;
    const key = `${t.chain}:${eg.symbol}`;
    inferencePairs.set(key, [...(inferencePairs.get(key) ?? []), { raw: eg.rawSum, csv: cg.sum }]);
    for (const l of eg.legs)
      assetIdBySymbol.set(key, (assetIdBySymbol.get(key) ?? new Set()).add(l.assetId));
  }
}

const inferredDecimals = new Map<string, { decimals: number; share: number; n: number }>();
for (const [key, pairs] of inferencePairs) {
  if (KNOWN_DECIMALS[key] !== undefined) continue;
  const votes = new Map<number, number>();
  for (const p of pairs) {
    const d = Math.round(Math.log10(p.raw / p.csv));
    votes.set(d, (votes.get(d) ?? 0) + 1);
  }
  if (votes.size === 0) continue;
  const [best, n] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  const total = [...votes.values()].reduce((a, b) => a + b, 0);
  inferredDecimals.set(key, { decimals: best, share: n / total, n: total });
}

function decimalsFor(chain: Chain, symbol: string): number | null {
  const key = `${chain}:${symbol}`;
  if (KNOWN_DECIMALS[key] !== undefined) return KNOWN_DECIMALS[key];
  const inf = inferredDecimals.get(key);
  return inf && inf.share >= 0.8 ? inf.decimals : null;
}

// pass 2: group matching (amounts) + greedy in-group leg pairing (labels)
const REL_TOL = 0.005;
interface MatchedGroup {
  chain: Chain;
  txKey: string; // `${chain}:${txHash}`
  txHash: string;
  symbol: string;
  dir: 'out' | 'in';
  csvSum: number;
  evSum: number;
  relDiff: number;
  evTypes: string[]; // distinct type:subtype of the event legs in the group
}
interface PairedLeg {
  chain: Chain;
  txHash: string;
  symbol: string;
  dir: 'out' | 'in';
  theirLabel: string;
  ourKey: string; // type:subtype
  comment: string;
}
const matchedGroups: MatchedGroup[] = [];
const pairedLegs: PairedLeg[] = [];
const unmatchedCsvLegs = new Map<string, { count: number; examples: string[] }>();
const unmatchedEvLegs = new Map<string, { count: number; examples: string[] }>();
const noDecimalsGroups = new Map<string, number>();

const POSITION_NFT_SYMBOLS = new Set(['OWP', 'AERO-CL-POS']);

for (const t of coveredTxs) {
  for (const [gk, cg] of t.groups.csv) {
    const eg = t.groups.ev.get(gk);
    if (!eg) {
      const cat = POSITION_NFT_SYMBOLS.has(cg.symbol)
        ? 'position-NFT placeholder (Blockpit models the NFT as an asset; we model positionId)'
        : cg.legs.every((l) => l.row.label === 'Non-Taxable In')
          ? 'spam/dust airdrop leg (Non-Taxable In)'
          : `no event leg for ${cg.dir} ${cg.symbol}`;
      const key = `${t.chain}|${cat}`;
      const b = unmatchedCsvLegs.get(key) ?? { count: 0, examples: [] };
      b.count += cg.legs.length;
      if (b.examples.length < 3) b.examples.push(`${t.txHash} (${cg.dir} ${cg.symbol})`);
      unmatchedCsvLegs.set(key, b);
      continue;
    }
    const d = decimalsFor(t.chain, eg.symbol);
    if (d === null) {
      noDecimalsGroups.set(
        `${t.chain}:${eg.symbol}`,
        (noDecimalsGroups.get(`${t.chain}:${eg.symbol}`) ?? 0) + 1,
      );
      continue;
    }
    const evSum = eg.rawSum / 10 ** d;
    const relDiff =
      Math.max(evSum, cg.sum) === 0 ? 0 : Math.abs(evSum - cg.sum) / Math.max(evSum, cg.sum);
    matchedGroups.push({
      chain: t.chain,
      txKey: t.k,
      txHash: t.txHash,
      symbol: cg.symbol,
      dir: cg.dir,
      csvSum: cg.sum,
      evSum,
      relDiff,
      evTypes: [...new Set(eg.legs.map((l) => `${l.type}:${l.subtype}`))],
    });
    // classification: pair legs inside the group greedily by closest amount
    const evLegsSorted = [...eg.legs].sort((a, b) => b.raw - a.raw);
    const csvLegsSorted = [...cg.legs].sort((a, b) => b.amount - a.amount);
    const n = Math.min(evLegsSorted.length, csvLegsSorted.length);
    for (let i = 0; i < n; i++) {
      pairedLegs.push({
        chain: t.chain,
        txHash: t.txHash,
        symbol: cg.symbol,
        dir: cg.dir,
        theirLabel: csvLegsSorted[i].row.label,
        ourKey: `${evLegsSorted[i].type}:${evLegsSorted[i].subtype}`,
        comment: csvLegsSorted[i].row.comment,
      });
    }
    void gk;
  }
  for (const [gk, eg] of t.groups.ev) {
    if (t.groups.csv.has(gk)) continue;
    const key = `${t.chain}|${[...new Set(eg.legs.map((l) => `${l.type}:${l.subtype}`))].join('+')} (${eg.dir} ${eg.symbol.length > 24 ? eg.symbol.slice(0, 10) + '…' : eg.symbol})`;
    const b = unmatchedEvLegs.get(key) ?? { count: 0, examples: [] };
    b.count += eg.legs.length;
    if (b.examples.length < 3) b.examples.push(t.txHash);
    unmatchedEvLegs.set(key, b);
  }
}

// --- gas-fee agreement (CSV fee columns vs our gas:fee events) ----------------

const NATIVE: Record<Chain, { symbol: string; decimals: number }> = {
  base: { symbol: 'ETH', decimals: 18 },
  solana: { symbol: 'SOL', decimals: 9 },
  sui: { symbol: 'SUI', decimals: 9 },
};
let gasBoth = 0;
let gasOk = 0;
const gasOutliers: string[] = [];
for (const [k, txRows] of csvByTx) {
  const txEvents = evByTx.get(k);
  if (!txEvents) continue;
  const chain = CSV_CHAIN[txRows[0].sourceName];
  const native = NATIVE[chain];
  const csvFee = txRows
    .filter((r) => groupOf(r.feeAsset).toUpperCase() === groupOf(native.symbol).toUpperCase())
    .reduce((a, r) => a + (r.feeAmount ?? 0), 0);
  const evGas =
    txEvents
      .filter((e) => e.type === 'gas' && e.sentAmount !== null)
      .reduce((a, e) => a + Number(e.sentAmount), 0) /
    10 ** native.decimals;
  if (csvFee <= 0 || evGas <= 0) continue;
  gasBoth++;
  const relDiff = Math.abs(evGas - csvFee) / Math.max(evGas, csvFee);
  if (relDiff <= REL_TOL) gasOk++;
  else if (gasOutliers.length < 5)
    gasOutliers.push(`\`${k.slice(k.indexOf(':') + 1)}\` csv=${csvFee} vs events=${evGas}`);
}

// --- heuristic join for rows without a Trx. ID -------------------------------

let heuristicMatched = 0;
for (const r of csvNoTxId) {
  const chain = CSV_CHAIN[r.sourceName];
  const sides: Array<['out' | 'in', string, number | null]> = [
    ['out', r.outAsset, r.outAmount],
    ['in', r.inAsset, r.inAmount],
  ];
  for (const [dir, asset, amount] of sides) {
    if (asset === '' || amount === null) continue;
    const hit = events.some((e) => {
      if (e.chain !== chain || Math.abs(e.ts - r.ts) > 120) return false;
      for (const l of evLegs(e)) {
        if (l.dir !== dir) continue;
        if (groupOf(l.symbol).toUpperCase() !== groupOf(asset).toUpperCase()) continue;
        const d = decimalsFor(chain, l.symbol);
        if (d === null) continue;
        const ev = l.raw / 10 ** d;
        if (Math.abs(ev - amount) / Math.max(ev, amount, 1e-12) <= REL_TOL) return true;
      }
      return false;
    });
    if (hit) heuristicMatched++;
  }
}

// --- classification agreement -------------------------------------------------

const matrix = new Map<string, number>(); // `${ourKey}|${dir}|${theirLabel}` → count
let agree = 0;
let theirFallback = 0;
let disagree = 0;
const disagreeExamples = new Map<string, { count: number; examples: string[] }>();

for (const m of pairedLegs) {
  const mk = `${m.ourKey}|${m.dir}|${m.theirLabel}`;
  matrix.set(mk, (matrix.get(mk) ?? 0) + 1);
  const expected = EXPECTED_LABELS[`${m.ourKey}:${m.dir}`] ?? [];
  if (expected.includes(m.theirLabel)) {
    agree++;
  } else if (
    m.ourKey === 'swap:trade' &&
    (m.theirLabel === 'Deposit' || m.theirLabel === 'Withdrawal')
  ) {
    theirFallback++; // Blockpit failed to pair the swap (Fallback rows)
  } else {
    disagree++;
    const key = `${m.ourKey} (${m.dir}) vs '${m.theirLabel}'`;
    const b = disagreeExamples.get(key) ?? { count: 0, examples: [] };
    b.count++;
    if (b.examples.length < 3) b.examples.push(`${m.txHash} (${m.symbol})`);
    disagreeExamples.set(key, b);
  }
}

// --- Source B: corrected pipeline output — classification source of truth ----
//
// The raw export (source A, above) contains known misclassifications; the
// owner's corrected tax-report output is authoritative for labels. Rows whose
// Trx. ID starts with `lp-` are SYNTHETIC injected legs (LP basis
// carry-forward / fee-at-close rows generated by inject_lp_events.py) with no
// on-chain tx — counted as known-synthetic, never as missing coverage. The
// correction pipeline also REMOVED every Sickle/NPM-related raw row and
// replaced them with those synthetic per-position rows, so Base Sickle txs we
// decode are expected to be absent from B (bucketed as removed-by-correction).

const correctedFlag = process.argv.indexOf('--corrected');
const CORRECTED_PATH =
  correctedFlag >= 0
    ? process.argv[correctedFlag + 1]
    : '/home/felix/Code/Misc/defi-tracker/liquidity-sheets/tax-report-2025/04d-lp-positions/Transactions_with_lp_corrections.csv';

const bRowsAll = await readCsv(CORRECTED_PATH);
const bSynthetic: CsvRow[] = [];
const bExcluded = { cex: 0, ethereum: 0, polygon: 0, manual: 0, otherSource: 0 };
const bInScope: CsvRow[] = [];
for (const r of bRowsAll) {
  if (r.txId.startsWith('lp-')) bSynthetic.push(r);
  else if (r.sourceType === 'API') bExcluded.cex++;
  else if (r.sourceType === 'Manual') bExcluded.manual++;
  else if (r.sourceName === 'Ethereum') bExcluded.ethereum++;
  else if (r.sourceName === 'Polygon') bExcluded.polygon++;
  else if (CSV_CHAIN[r.sourceName]) bInScope.push(r);
  else bExcluded.otherSource++;
}
const bByTx = new Map<string, CsvRow[]>();
for (const r of bInScope) {
  if (r.txId === '') continue;
  const k = `${CSV_CHAIN[r.sourceName]}:${r.txId}`;
  bByTx.set(k, [...(bByTx.get(k) ?? []), r]);
}

// pair legs inside (dir, asset) groups on txs covered by both — same mechanics
// as source A.
const pairedLegsB: PairedLeg[] = [];
let bCoveredTxs = 0;
for (const [k, txRows] of bByTx) {
  const txEvents = evByTx.get(k);
  if (!txEvents) continue;
  bCoveredTxs++;
  const chain = CSV_CHAIN[txRows[0].sourceName];
  const txHash = k.slice(k.indexOf(':') + 1);
  const groups = buildGroups(chain, txEvents, txRows);
  for (const [gk, cg] of groups.csv) {
    const eg = groups.ev.get(gk);
    if (!eg) continue;
    const evLegsSorted = [...eg.legs].sort((a, b) => b.raw - a.raw);
    const csvLegsSorted = [...cg.legs].sort((a, b) => b.amount - a.amount);
    const n = Math.min(evLegsSorted.length, csvLegsSorted.length);
    for (let i = 0; i < n; i++) {
      pairedLegsB.push({
        chain,
        txHash,
        symbol: cg.symbol,
        dir: cg.dir,
        theirLabel: csvLegsSorted[i].row.label,
        ourKey: `${evLegsSorted[i].type}:${evLegsSorted[i].subtype}`,
        comment: csvLegsSorted[i].row.comment,
      });
    }
    void gk;
  }
}

// Raw-export leg labels, used to discriminate disagreement causes: if B's
// label for a leg equals the RAW export's label for the same (tx, dir, asset),
// the correction pipeline never touched that leg — it is an uncorrected
// RESIDUAL Blockpit misclassification, not a deliberate correction that
// contradicts us.
const aLegLabels = new Map<string, Set<string>>();
for (const [k, txRows] of csvByTx) {
  for (const r of txRows) {
    if (r.outAsset !== '')
      aLegLabels.set(
        `${k}|out|${groupOf(r.outAsset).toUpperCase()}`,
        (aLegLabels.get(`${k}|out|${groupOf(r.outAsset).toUpperCase()}`) ?? new Set()).add(r.label),
      );
    if (r.inAsset !== '')
      aLegLabels.set(
        `${k}|in|${groupOf(r.inAsset).toUpperCase()}`,
        (aLegLabels.get(`${k}|in|${groupOf(r.inAsset).toUpperCase()}`) ?? new Set()).add(r.label),
      );
  }
}

const matrixB = new Map<string, number>();
let agreeB = 0;
let fallbackB = 0;
let disagreeB = 0;
interface DisagreeBucketB {
  count: number;
  residual: number; // B label == raw label → pipeline never corrected this leg
  deliberate: number; // B label != raw label → a correction that contradicts us
  examples: string[];
  comments: Map<string, number>;
}
const disagreeExamplesB = new Map<string, DisagreeBucketB>();
for (const m of pairedLegsB) {
  const mk = `${m.ourKey}|${m.dir}|${m.theirLabel}`;
  matrixB.set(mk, (matrixB.get(mk) ?? 0) + 1);
  const expected = EXPECTED_LABELS_CORRECTED[`${m.ourKey}:${m.dir}`] ?? [];
  if (expected.includes(m.theirLabel)) {
    agreeB++;
  } else if (
    m.ourKey === 'swap:trade' &&
    (m.theirLabel === 'Deposit' || m.theirLabel === 'Withdrawal') &&
    /fallback/i.test(m.comment)
  ) {
    fallbackB++; // un-fixed Blockpit fallback rows that survived into B
  } else {
    disagreeB++;
    const key = `${m.ourKey} (${m.dir}) vs '${m.theirLabel}'`;
    const b =
      disagreeExamplesB.get(key) ??
      ({
        count: 0,
        residual: 0,
        deliberate: 0,
        examples: [],
        comments: new Map(),
      } as DisagreeBucketB);
    b.count++;
    const rawLabels = aLegLabels.get(
      `${m.chain}:${m.txHash}|${m.dir}|${groupOf(m.symbol).toUpperCase()}`,
    );
    if (rawLabels?.has(m.theirLabel)) b.residual++;
    else b.deliberate++;
    if (b.examples.length < 3) b.examples.push(`${m.txHash} (${m.symbol})`);
    const c = m.comment === '' ? '(none)' : m.comment;
    b.comments.set(c, (b.comments.get(c) ?? 0) + 1);
    disagreeExamplesB.set(key, b);
  }
}

// coverage context vs B (informational — the official coverage metric is
// source A; B deliberately removes and synthesizes rows).
const dbVsB = {
  covered: bCoveredTxs,
  removedByCorrection: 0,
  gasOnly: 0,
  outsideRange: 0,
  other: 0,
};
const removedByCorrectionExamples: string[] = [];
for (const [k, txEvents] of evByTx) {
  if (bByTx.has(k)) continue;
  const ts = txEvents[0].ts;
  if (csvByTx.has(k)) {
    dbVsB.removedByCorrection++;
    if (removedByCorrectionExamples.length < 3)
      removedByCorrectionExamples.push(k.slice(k.indexOf(':') + 1));
  } else if (txEvents.every((e) => e.type === 'gas')) dbVsB.gasOnly++;
  else if (ts < csvTsMin - 120 || ts > csvTsMax + 120) dbVsB.outsideRange++;
  else dbVsB.other++;
}
let bMissingFromDbTxs = 0;
for (const k of bByTx.keys()) {
  if (!evByTx.has(k) && !protocolExcludedTxs.has(k)) bMissingFromDbTxs++;
}

// --- amount agreement sample of 50 -------------------------------------------

const allPairs = [...matchedGroups].sort((a, b) =>
  `${a.txHash}${a.dir}${a.symbol}`.localeCompare(`${b.txHash}${b.dir}${b.symbol}`),
);
const step = Math.max(1, Math.floor(allPairs.length / 50));
const sample = allPairs.filter((_, i) => i % step === 0).slice(0, 50);
const sampleOk = sample.filter((s) => s.relDiff <= REL_TOL);
const sampleOutliers = sample.filter((s) => s.relDiff > REL_TOL);

// ---------------------------------------------------------------------------
// Markdown output
// ---------------------------------------------------------------------------

const out: string[] = [];
const p = (s = '') => out.push(s);
const pct = (a: number, b: number) => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(1)}%`);
const fmtLabels = (m: Map<string, number>) =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l}×${n}`)
    .join(', ');

p(`## Inputs`);
p();
p(`- Blockpit CSV: \`${CSV_PATH}\` — ${rows.length} data rows`);
p(
  `- CSV in-scope rows (Base/Solana/Sui chain rows): ${inScope.length}; distinct txs with Trx. ID: ${csvByTx.size}; rows without Trx. ID: ${csvNoTxId.length}`,
);
p(`- DB events: ${events.length} rows across ${evByTx.size} txs; raw_txs: ${rawTxSet.size}`);
p(
  `- CSV date range (UTC): ${new Date(csvTsMin * 1000).toISOString()} → ${new Date(csvTsMax * 1000).toISOString()}`,
);
p();
p(`## Known-out-of-scope rows (excluded from coverage, counted separately)`);
p();
p(`| exclusion | rows |`);
p(`|---|---|`);
p(`| Bitvavo / CEX (Source Type=API) | ${excluded.cex} |`);
p(`| Ethereum chain | ${excluded.ethereum} |`);
p(`| Polygon chain | ${excluded.polygon} |`);
p(`| Manual rows | ${excluded.manual} |`);
p(`| other/unknown source | ${excluded.otherSource} |`);
p(
  `| out-of-scope Sui protocol txs (Cetus + unidentified DEXes, see below) | ${protocolExcludedRowCount} rows / ${protocolExcludedTxs.size} txs |`,
);
p();
const protoCounts = new Map<string, number>();
for (const name of protocolExcludedTxs.values())
  protoCounts.set(name, (protoCounts.get(name) ?? 0) + 1);
p(`Out-of-scope protocol tx breakdown (first matching marker per tx):`);
p();
for (const [name, n] of [...protoCounts.entries()].sort((a, b) => b[1] - a[1]))
  p(`- ${name}: ${n} txs`);
p();
p(`## Tx-level coverage — CSV → DB (does our pipeline see what Blockpit saw?)`);
p();
p(`| chain | CSV txs (in scope) | covered by events | rate |`);
p(`|---|---|---|---|`);
for (const chain of ['base', 'solana', 'sui'] as Chain[])
  p(
    `| ${chain} | ${csvTotal.get(chain)} | ${csvCovered.get(chain)} | ${pct(csvCovered.get(chain)!, csvTotal.get(chain)!)} |`,
  );
p();
p(`Misses by bucket:`);
p();
for (const [key, b] of [...csvMisses.entries()].sort((a, b) => b[1].count - a[1].count)) {
  const [chain, bucket] = key.split('|');
  p(`- **${chain} — ${bucket}**: ${b.count} txs / ${b.rows} rows (labels: ${fmtLabels(b.labels)})`);
  p(`  - examples: ${b.examples.map((e) => `\`${e}\``).join(', ')}`);
}
p();
p(`## Tx-level coverage — DB → CSV (did Blockpit see what we decoded?)`);
p();
p(`| chain | DB event txs | present in CSV | rate |`);
p(`|---|---|---|---|`);
for (const chain of ['base', 'solana', 'sui'] as Chain[])
  p(
    `| ${chain} | ${dbTotal.get(chain) ?? 0} | ${dbCovered.get(chain) ?? 0} | ${pct(dbCovered.get(chain) ?? 0, dbTotal.get(chain) ?? 0)} |`,
  );
p();
for (const [key, b] of [...dbMisses.entries()].sort((a, b) => b[1].count - a[1].count)) {
  const [chain, bucket] = key.split('|');
  const types = [...b.types.entries()]
    .sort((a, c) => c[1] - a[1])
    .map(([t, n]) => `${t}×${n}`)
    .join(', ');
  p(`- **${chain} — ${bucket}**: ${b.count} txs (event types: ${types})`);
  p(`  - examples: ${b.examples.map((e) => `\`${e}\``).join(', ')}`);
}
p();
p(`## Group-level matching (within txs covered by both)`);
p();
p(`Groups = per-tx (direction, asset) flow sums — Blockpit aggregates per tx,`);
p(`our events are per instruction, so sums are the comparable unit.`);
p();
const groupsOk = matchedGroups.filter((g) => g.relDiff <= REL_TOL).length;
p(`- matched groups (asset present on both sides): ${matchedGroups.length}`);
p(
  `- amounts agree within ${REL_TOL * 100}%: ${groupsOk}/${matchedGroups.length} (${pct(groupsOk, matchedGroups.length)})`,
);
if (noDecimalsGroups.size > 0)
  p(
    `- groups skipped (no confident decimals): ${[...noDecimalsGroups.entries()].map(([k, n]) => `${k}×${n}`).join(', ')}`,
  );
p(`- CSV legs with no event counterpart:`);
for (const [key, b] of [...unmatchedCsvLegs.entries()].sort((a, c) => c[1].count - a[1].count)) {
  const [chain, cat] = key.split('|');
  p(`  - ${chain} — ${cat}: ${b.count} (e.g. ${b.examples.map((e) => `\`${e}\``).join(', ')})`);
}
p(`- event legs with no CSV counterpart:`);
for (const [key, b] of [...unmatchedEvLegs.entries()].sort((a, c) => c[1].count - a[1].count)) {
  const [chain, cat] = key.split('|');
  p(`  - ${chain} — ${cat}: ${b.count} (e.g. ${b.examples.map((e) => `\`${e}\``).join(', ')})`);
}
p();
p(`Heuristic (no Trx. ID) rows: ${csvNoTxId.length} rows → ${heuristicMatched} legs matched`);
p(`via (timestamp ±2 min, asset, amount).`);
p();
p(`Inferred decimals (assets without a confident static entry):`);
p();
p(`| chain:symbol | inferred decimals | vote share | samples | event asset ids |`);
p(`|---|---|---|---|---|`);
for (const [key, inf] of [...inferredDecimals.entries()].sort()) {
  const ids = [...(assetIdBySymbol.get(key) ?? [])].map((i) =>
    i.length > 24 ? `${i.slice(0, 10)}…${i.slice(-6)}` : i,
  );
  p(
    `| ${key} | ${inf.decimals} | ${(inf.share * 100).toFixed(0)}% | ${inf.n} | ${ids.join(', ')} |`,
  );
}
p();
p(`## Classification agreement (matched legs)`);
p();
p(`- agree (their label ∈ expected set for our type:subtype): ${agree}`);
p(
  `- their-fallback (swap legs Blockpit recorded as bare Deposit/Withdrawal — Blockpit decode gap, not ours): ${theirFallback}`,
);
p(`- disagree: ${disagree}`);
p();
if (disagreeExamples.size > 0) {
  p(`Disagreements:`);
  p();
  for (const [key, b] of [...disagreeExamples.entries()].sort((a, c) => c[1].count - a[1].count))
    p(`- ${key}: ${b.count} (e.g. ${b.examples.map((e) => `\`${e}\``).join(', ')})`);
  p();
}
p(`Full matrix (our type:subtype × their Label):`);
p();
p(`| ours | dir | their label | count |`);
p(`|---|---|---|---|`);
for (const [key, n] of [...matrix.entries()].sort((a, b) => b[1] - a[1])) {
  const [ourKey, dir, label] = key.split('|');
  p(`| ${ourKey} | ${dir} | ${label} | ${n} |`);
}
p();
p(`## Classification agreement vs SOURCE B (corrected pipeline output — source of truth)`);
p();
p(`- corrected CSV: \`${CORRECTED_PATH}\` — ${bRowsAll.length} data rows`);
p(
  `- known-synthetic injected rows (Trx. ID \`lp-…\`, LP basis carry-forward legs, no on-chain tx): ${bSynthetic.length}`,
);
p(
  `- excluded (same scope rules as A): CEX ${bExcluded.cex}, Ethereum ${bExcluded.ethereum}, Polygon ${bExcluded.polygon}, Manual ${bExcluded.manual}, other ${bExcluded.otherSource}`,
);
p(
  `- in-scope corrected txs: ${bByTx.size}; matched against DB events: ${bCoveredTxs}; corrected txs with no DB events (mostly same gaps as source A): ${bMissingFromDbTxs}`,
);
p(
  `- DB event txs absent from B: removed-by-correction (Sickle/NPM rows replaced by synthetic position rows): ${dbVsB.removedByCorrection} (e.g. ${removedByCorrectionExamples.map((e) => `\`${e}\``).join(', ')}); gas-only: ${dbVsB.gasOnly}; outside range: ${dbVsB.outsideRange}; other: ${dbVsB.other}`,
);
p();
p(`Paired legs: ${pairedLegsB.length}`);
p();
p(
  `- **agree** (their corrected label ∈ expected set): ${agreeB} (${pct(agreeB, pairedLegsB.length)})`,
);
p(`- their-fallback (un-fixed Blockpit fallback swap rows that survived into B): ${fallbackB}`);
p(`- **disagree**: ${disagreeB} (${pct(disagreeB, pairedLegsB.length)})`);
p();
if (disagreeExamplesB.size > 0) {
  p(
    `Disagreements (residual = B label identical to raw export, i.e. their pipeline never corrected the leg; deliberate = their correction actively chose this label):`,
  );
  p();
  for (const [key, b] of [...disagreeExamplesB.entries()].sort((a, c) => c[1].count - a[1].count)) {
    const comments = [...b.comments.entries()]
      .sort((a, c) => c[1] - a[1])
      .slice(0, 4)
      .map(([cm, n]) => `${cm}×${n}`)
      .join(', ');
    p(
      `- ${key}: ${b.count} (residual ${b.residual} / deliberate ${b.deliberate}; comments: ${comments})`,
    );
    p(`  - examples: ${b.examples.map((e) => `\`${e}\``).join(', ')}`);
  }
  p();
}
p(`Full matrix vs B (our type:subtype × their corrected Label):`);
p();
p(`| ours | dir | their label | count |`);
p(`|---|---|---|---|`);
for (const [key, n] of [...matrixB.entries()].sort((a, b) => b[1] - a[1])) {
  const [ourKey, dir, label] = key.split('|');
  p(`| ${ourKey} | ${dir} | ${label} | ${n} |`);
}
p();
p(`## Amount agreement — deterministic sample of ${sample.length} matched flow groups`);
p();
const diffs = sample.map((s) => s.relDiff);
const mean = diffs.reduce((a, b) => a + b, 0) / Math.max(1, diffs.length);
p(`- within ${REL_TOL * 100}% tolerance: ${sampleOk.length}/${sample.length}`);
p(
  `- mean relative diff: ${(mean * 100).toFixed(4)}%; max: ${(Math.max(0, ...diffs) * 100).toFixed(4)}%`,
);
if (sampleOutliers.length > 0) {
  p(`- outliers:`);
  for (const s of sampleOutliers)
    p(
      `  - \`${s.txHash}\` ${s.dir} ${s.symbol}: csv=${s.csvSum} vs events=${s.evSum} (${(s.relDiff * 100).toFixed(2)}%)`,
    );
}
p();
p(`Amount mismatches across ALL matched groups (> ${REL_TOL * 100}%), categorized:`);
p();
const allMismatches = matchedGroups
  .filter((g) => g.relDiff > REL_TOL)
  .sort((a, b) => b.relDiff - a.relDiff);
/**
 * - dust-vs-internal-leg: one side is negligible vs the other — Blockpit
 *   recorded only a wei-level router refund while our group contains internal
 *   zap legs (wrap/swap inside the tx), or vice versa.
 * - custody-chain double-count: group sums a transfer:send (wallet→proxy)
 *   PLUS the lp_* leg (proxy→pool) of the same flow (vfat/Sickle model).
 * - zap multi-type group: several event types share the (dir, asset) group —
 *   per-tx sums are not directly comparable to Blockpit's net-flow row.
 * - unexplained: none of the above; needs a manual look.
 */
function mismatchCategory(g: MatchedGroup): string {
  const ratio = Math.min(g.csvSum, g.evSum) / Math.max(g.csvSum, g.evSum);
  if (ratio < 0.001) return 'dust-vs-internal-leg';
  if (g.evTypes.includes('transfer:send') && g.evTypes.some((t) => t.startsWith('lp_')))
    return 'custody-chain double-count (send + lp leg)';
  if (g.evTypes.length > 1) return `zap multi-type group (${g.evTypes.join('+')})`;
  return `unexplained (${g.evTypes.join('+')})`;
}
const mismatchByCat = new Map<string, MatchedGroup[]>();
for (const g of allMismatches) {
  const c = mismatchCategory(g);
  mismatchByCat.set(c, [...(mismatchByCat.get(c) ?? []), g]);
}
p(`- total: ${allMismatches.length}/${matchedGroups.length}`);
for (const [cat, gs] of [...mismatchByCat.entries()].sort((a, b) => b[1].length - a[1].length)) {
  p(`- **${cat}**: ${gs.length}`);
  for (const s of gs.slice(0, 4))
    p(
      `  - \`${s.txHash}\` ${s.dir} ${s.symbol}: csv=${s.csvSum} vs events=${s.evSum} (${(s.relDiff * 100).toFixed(2)}%)`,
    );
}
p();
p(`## Gas-fee agreement (CSV fee columns vs our gas:fee events, per tx)`);
p();
p(
  `- txs with a fee on both sides: ${gasBoth}; agree within ${REL_TOL * 100}%: ${gasOk} (${pct(gasOk, gasBoth)})`,
);
if (gasOutliers.length > 0) p(`- example mismatches: ${gasOutliers.join('; ')}`);
p();

console.log(out.join('\n'));
close();
