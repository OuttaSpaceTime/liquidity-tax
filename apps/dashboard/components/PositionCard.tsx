import Link from 'next/link';
import type { PositionDTO } from '@/lib/queries';
import { ChainBadge, ProtocolBadge, WalletLabel, Amounts, FlagPills } from './atoms';
import { formatEur } from '@/lib/format';

function taxFreeText(p: PositionDTO): string {
  if (p.daysUntilTaxFree <= 0) return 'tax-free (held ≥ 1y)*';
  return `tax-free in ${p.daysUntilTaxFree}d*`;
}

function estText(p: PositionDTO): { value: string; note: string } {
  switch (p.estValueNote) {
    case 'ok':
      return { value: formatEur(p.estValueEur), note: 'principal @ latest close (est., not P/L)' };
    case 'negative_principal':
      return { value: '—', note: 'net of withdrawals (signed per asset)' };
    case 'no_price':
      return { value: '—', note: 'price pending for some assets' };
  }
}

export function PositionCard({ position: p }: { position: PositionDTO }) {
  const est = estText(p);
  return (
    <div className="card pcard">
      <div className="head">
        <ProtocolBadge protocol={p.protocol} />
        <ChainBadge chain={p.chain} />
        <WalletLabel label={p.walletLabel} />
        {p.inferredOpen && (
          <span className="pill warn" title="History starts mid-lifecycle; economics may be understated.">
            inferred open
          </span>
        )}
      </div>

      <Link href={`/positions/${encodeURIComponent(p.positionId)}`} className="mono dim" style={{ fontSize: 12 }}>
        {p.positionId}
      </Link>

      <div className="rows">
        <span className="k">Principal</span>
        <Amounts items={p.principal} />
        {p.feesCollected.length > 0 && (
          <>
            <span className="k">Fees</span>
            <Amounts items={p.feesCollected} />
          </>
        )}
        {p.rewardsCollected.length > 0 && (
          <>
            <span className="k">Rewards</span>
            <Amounts items={p.rewardsCollected} />
          </>
        )}
      </div>

      <div>
        <div className="est">{est.value}</div>
        <div className="faint" style={{ fontSize: 11 }}>
          {est.note}
        </div>
      </div>

      {p.warnings.length > 0 && <FlagPills flags={p.warnings} />}

      <div className="meta">
        <span>age {p.ageDays}d</span>
        <span>{taxFreeText(p)}</span>
        <span>{p.eventCount} events</span>
      </div>
    </div>
  );
}
