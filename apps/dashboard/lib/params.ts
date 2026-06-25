import type { Chain, TaxEventType } from '@lt/types/event';

export type SP = Record<string, string | string[] | undefined>;

const CHAINS = new Set<string>(['base', 'solana', 'sui']);
const TYPES = new Set<string>([
  'transfer',
  'swap',
  'lp_deposit',
  'lp_withdraw',
  'lp_fee',
  'lp_reward',
  'lend_supply',
  'lend_borrow',
  'lend_interest',
  'lend_reward',
  'liquidation',
  'stake',
  'bridge',
  'gas',
  'unknown',
]);

function str(sp: SP, key: string): string | undefined {
  const v = sp[key];
  return typeof v === 'string' ? v : undefined;
}

export function parseChain(sp: SP): Chain | undefined {
  const c = str(sp, 'chain');
  return c !== undefined && CHAINS.has(c) ? (c as Chain) : undefined;
}

export function parseType(sp: SP): TaxEventType | undefined {
  const t = str(sp, 'type');
  return t !== undefined && TYPES.has(t) ? (t as TaxEventType) : undefined;
}

export function parseCursor(sp: SP): { timestamp: number; id: number } | null {
  const c = str(sp, 'cursor');
  if (c === undefined) return null;
  const [ts, id] = c.split('_').map(Number);
  return Number.isFinite(ts) && Number.isFinite(id) ? { timestamp: ts, id } : null;
}

export function encodeCursor(c: { timestamp: number; id: number }): string {
  return `${c.timestamp}_${c.id}`;
}
