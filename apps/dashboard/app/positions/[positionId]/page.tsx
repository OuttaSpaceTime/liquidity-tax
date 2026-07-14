import { notFound } from 'next/navigation';
import { getPositionDetail } from '@/lib/queries';
import { Topbar } from '@/components/Topbar';
import { Timeline } from '@/components/Timeline';
import { ChainBadge, ProtocolBadge, WalletLabel, Amounts, FlagPills, TxLink, EmptyState } from '@/components/atoms';
import { formatDate, formatEur } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function PositionDetailPage({
  params,
}: {
  params: Promise<{ positionId: string }>;
}) {
  const { positionId } = await params;
  const id = decodeURIComponent(positionId);
  const detail = (await getPositionDetail(id)) ?? (await getPositionDetail(positionId));
  if (detail === null) notFound();
  const p = detail.position;

  return (
    <>
      <Topbar title="Position" subtitle={p.positionId} />

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="head" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <ProtocolBadge protocol={p.protocol} />
          <ChainBadge chain={p.chain} />
          <WalletLabel label={p.walletLabel} />
          <span className={`pill ${p.status === 'open' ? 'in' : 'neutral'}`}>{p.status}</span>
          {p.inferredOpen && (
            <span className="pill warn" title="History starts mid-lifecycle.">
              inferred open
            </span>
          )}
        </div>
        <div className="dim" style={{ marginTop: 8, fontSize: 12 }}>
          opened {formatDate(p.openedAt)}
          {p.closedAt ? ` · closed ${formatDate(p.closedAt)} · held ${p.holdingDays}d` : ` · age ${p.ageDays}d`}
          {p.status === 'open' &&
            (p.daysUntilTaxFree <= 0 ? ' · tax-free (held ≥ 1y)*' : ` · tax-free in ${p.daysUntilTaxFree}d*`)}
        </div>
        {p.warnings.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <FlagPills flags={p.warnings} />
          </div>
        )}
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>State (from decoded events)</h3>
          <div className="pcard rows" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px' }}>
            <span className="k faint">deposited</span>
            <Amounts items={p.deposited} />
            <span className="k faint">withdrawn</span>
            <Amounts items={p.withdrawn} />
            <span className="k faint">principal</span>
            <Amounts items={p.principal} />
            {p.debt.length > 0 && (
              <>
                <span className="k faint">debt</span>
                <Amounts items={p.debt} />
              </>
            )}
            <span className="k faint">fees</span>
            <Amounts items={p.feesCollected} />
            <span className="k faint">rewards</span>
            <Amounts items={p.rewardsCollected} />
          </div>
        </div>
        <div className="card">
          <h3>Valuation</h3>
          <div className="est" style={{ fontSize: 22 }}>
            {p.estValueNote === 'ok' ? formatEur(p.estValueEur) : '—'}
          </div>
          <div className="faint" style={{ fontSize: 12 }}>
            principal @ latest close (estimate, not realized P/L)
          </div>
          <div className="dim" style={{ marginTop: 12, fontSize: 12 }}>
            harvested (priced): {formatEur(p.harvestedEur)}
          </div>
          <div className="dim" style={{ marginTop: 4, fontSize: 12 }}>
            open tx: {p.openTxHash ? <TxLink chain={p.chain} txHash={p.openTxHash} /> : '—'}
            {p.closeTxHash && (
              <>
                {' · '}close tx: <TxLink chain={p.chain} txHash={p.closeTxHash} />
              </>
            )}
          </div>
          <div className="banner" style={{ marginTop: 14 }}>
            Live on-chain value &amp; unclaimed fees are the Phase-3 live-read slice (needs RPC keys).
          </div>
        </div>
      </div>

      <div className="section-title">Lifecycle timeline · {p.eventCount} events</div>
      <div className="card">
        {detail.timeline.length === 0 ? <EmptyState>No events.</EmptyState> : <Timeline items={detail.timeline} />}
      </div>
    </>
  );
}
