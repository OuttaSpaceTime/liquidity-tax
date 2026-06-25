import type { ReactNode } from 'react';
import type { Chain } from '@lt/types/event';
import type { AmountDTO } from '@/lib/queries';
import type { EventVerb } from '@/lib/taxonomy';
import { flagMeta } from '@/lib/taxonomy';
import { formatEur, truncateHash, explorerTxUrl } from '@/lib/format';

const CHAIN_LABEL: Record<Chain, string> = { base: 'Base', solana: 'Solana', sui: 'Sui' };

export function ChainBadge({ chain }: { chain: Chain }) {
  return <span className={`badge chain-${chain}`}>{CHAIN_LABEL[chain] ?? chain}</span>;
}

export function ProtocolBadge({ protocol }: { protocol: string }) {
  return <span className="badge proto">{protocol.replace(/_/g, ' ')}</span>;
}

/** PRIVACY: renders the wallet label only — never the raw address. */
export function WalletLabel({ label }: { label: string }) {
  return <span className="badge wallet">{label}</span>;
}

export function Eur({ value }: { value: number | null | undefined }) {
  return <span className="mono">{formatEur(value)}</span>;
}

export function AmountView({ amount }: { amount: AmountDTO }) {
  const neg = amount.amount.startsWith('-');
  return (
    <span className={`amt${neg ? ' neg' : ''}`}>
      {amount.formatted} <span className="sym">{amount.asset}</span>
      {!amount.scaled && (
        <span className="pill raw" title="decimals unknown — shown as raw base units">
          raw
        </span>
      )}
    </span>
  );
}

export function Amounts({ items }: { items: AmountDTO[] }) {
  if (items.length === 0) return <span className="faint">—</span>;
  return (
    <span className="amounts">
      {items.map((a) => (
        <AmountView key={a.rawAsset} amount={a} />
      ))}
    </span>
  );
}

export function VerbBadge({ verb }: { verb: EventVerb }) {
  return <span className={`tone-${verb.tone}`} style={{ fontWeight: 600 }}>{verb.label}</span>;
}

export function FlagPills({ flags }: { flags: string[] }) {
  if (flags.length === 0) return null;
  return (
    <span className="flags">
      {flags.map((f) => {
        const m = flagMeta(f);
        return (
          <span key={f} className={`pill ${m.tone}`} title={m.hint}>
            {m.label}
          </span>
        );
      })}
    </span>
  );
}

export function StatTile({
  label,
  value,
  hint,
  phase2,
  sm,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  phase2?: boolean;
  sm?: boolean;
}) {
  return (
    <div className={`stat${phase2 ? ' phase2' : ''}`}>
      <div className="label">{label}</div>
      <div className={`value${sm ? ' sm' : ''}`}>{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function TxLink({ chain, txHash }: { chain: Chain; txHash: string }) {
  return (
    <a className="mono dim" href={explorerTxUrl(chain, txHash)} target="_blank" rel="noreferrer">
      {truncateHash(txHash)}
    </a>
  );
}

export function EmptyState({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="empty">
      <div>{children}</div>
      {hint && <div style={{ marginTop: 8 }}>{hint}</div>}
    </div>
  );
}

export function Phase2Note({ children }: { children: ReactNode }) {
  return <div className="banner">⚠ {children}</div>;
}
