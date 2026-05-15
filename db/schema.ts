import {
  sqliteTable,
  text,
  integer,
  blob,
  real,
  primaryKey,
  index,
  unique,
} from 'drizzle-orm/sqlite-core';
import type { TaxEventType } from '../src/types/event';

// raw_txs — source of truth.
export const rawTxs = sqliteTable(
  'raw_txs',
  {
    chain:          text('chain').notNull(),
    txHash:         text('tx_hash').notNull(),
    blockNumber:    integer('block_number').notNull(),
    blockTimestamp: integer('block_timestamp').notNull(),
    rawJson:        text('raw_json', { mode: 'json' }).$type<unknown>().notNull(),
    fetchedAt:      integer('fetched_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.chain, t.txHash] }) }),
);

// events — surrogate id + UNIQUE(chain,tx_hash,log_index,emission_seq).
export const events = sqliteTable(
  'events',
  {
    id:             integer('id').primaryKey({ autoIncrement: true }),
    chain:          text('chain').notNull(),
    txHash:         text('tx_hash').notNull(),
    logIndex:       integer('log_index').notNull(),
    emissionSeq:    integer('emission_seq').notNull().default(0),
    timestamp:      integer('timestamp').notNull(),
    wallet:         text('wallet').notNull(),
    type:           text('type').$type<TaxEventType>().notNull(),
    subtype:        text('subtype').$type<string>().notNull(),
    sentAsset:      text('sent_asset'),
    sentAmount:     blob('sent_amount', { mode: 'bigint' }),
    receivedAsset:  text('received_asset'),
    receivedAmount: blob('received_amount', { mode: 'bigint' }),
    priceUsdJson:   text('price_usd_json', { mode: 'json' }).$type<{
      sent?: string;
      received?: string;
      source: string;
    } | null>(),
    positionId:     text('position_id'),
    flagsJson:      text('flags_json', { mode: 'json' }).$type<string[]>(),
    handlerId:      text('handler_id').notNull(),
    handlerVersion: integer('handler_version').notNull(),
  },
  (t) => ({
    uq:         unique('events_uq').on(t.chain, t.txHash, t.logIndex, t.emissionSeq),
    byWallet:   index('events_by_wallet').on(t.wallet, t.timestamp),
    byPosition: index('events_by_position').on(t.positionId),
  }),
);

// positions
export const positions = sqliteTable('positions', {
  positionId: text('position_id').primaryKey(),
  chain:      text('chain').notNull(),
  protocol:   text('protocol').notNull(),
  wallet:     text('wallet').notNull(),
  openedAt:   integer('opened_at').notNull(),
  closedAt:   integer('closed_at'),
  stateJson:  text('state_json', { mode: 'json' }).$type<Record<string, unknown>>(),
});

// prices
export const prices = sqliteTable(
  'prices',
  {
    asset:    text('asset').notNull(),
    date:     text('date').notNull(),
    usdPrice: real('usd_price').notNull(),
    source:   text('source').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.asset, t.date] }) }),
);

// unclassified
export const unclassified = sqliteTable(
  'unclassified',
  {
    chain:       text('chain').notNull(),
    txHash:      text('tx_hash').notNull(),
    rawJson:     text('raw_json', { mode: 'json' }).$type<unknown>().notNull(),
    reason:      text('reason').notNull(),
    firstSeenAt: integer('first_seen_at').notNull(),
    resolvedAt:  integer('resolved_at'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.chain, t.txHash] }) }),
);

// rules
export const rules = sqliteTable('rules', {
  id:            integer('id').primaryKey({ autoIncrement: true }),
  matchJson:     text('match_json', { mode: 'json' })
                   .$type<Record<string, unknown>>()
                   .notNull(),
  templateJson:  text('template_json', { mode: 'json' })
                   .$type<Record<string, unknown>>()
                   .notNull(),
  priority:      integer('priority').notNull().default(0),
  createdAt:     integer('created_at').notNull(),
  lastAppliedAt: integer('last_applied_at'),
  appliedCount:  integer('applied_count').notNull().default(0),
});

// transfer_links — no FK references; events.id is surrogate.
export const transferLinks = sqliteTable(
  'transfer_links',
  {
    id:         integer('id').primaryKey({ autoIncrement: true }),
    outEventId: integer('out_event_id').notNull(),
    inEventId:  integer('in_event_id').notNull(),
    confidence: real('confidence').notNull(),
    status:     text('status', { enum: ['pending', 'confirmed', 'rejected'] })
                  .notNull()
                  .default('pending'),
    heuristic:  text('heuristic').notNull(),
  },
  (t) => ({
    byOutEvent: index('transfer_links_by_out_event').on(t.outEventId),
    byInEvent:  index('transfer_links_by_in_event').on(t.inEventId),
  }),
);
