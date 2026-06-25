import Link from 'next/link';
import { getOverview } from '@/lib/queries';
import { Topbar } from '@/components/Topbar';
import { StatTile, Phase2Note } from '@/components/atoms';
import { ActivityTable } from '@/components/ActivityTable';
import { formatEur } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const o = await getOverview();
  return (
    <>
      <Topbar title="Overview" subtitle="Where things stand right now" />

      <div className="grid cols-3">
        <StatTile label="Open positions" value={o.openPositions} />
        <StatTile label="Closed positions" value={o.closedPositions} />
        <StatTile
          label="Harvested (est.)"
          value={formatEur(o.harvestedEur)}
          hint="fees + rewards, priced; lower bound"
          sm
        />
        <StatTile label="Decoded events" value={o.totalEvents.toLocaleString('de-DE')} />
        <StatTile label="Unclassified queue" value={o.unclassifiedOpen} hint="awaiting manual labels" />
        <StatTile label="Pending links" value={o.pendingLinks} hint="transfer pairs to confirm" />
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h3>Events by chain</h3>
          <table className="table">
            <tbody>
              {o.eventsByChain.map((c) => (
                <tr key={c.chain}>
                  <td>{c.chain}</td>
                  <td className="num">{c.count.toLocaleString('de-DE')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3>Open positions by protocol</h3>
          <table className="table">
            <tbody>
              {o.protocols.length === 0 && (
                <tr>
                  <td className="faint">none open</td>
                </tr>
              )}
              {o.protocols.map((p) => (
                <tr key={p.protocol}>
                  <td>{p.protocol.replace(/_/g, ' ')}</td>
                  <td className="num">{p.open}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>Recent activity</span>
        <Link href="/activity" className="dim">
          all actions →
        </Link>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <ActivityTable items={o.recent} />
      </div>

      <Phase2Note>
        Realized §23/§22 gains, Freigrenzen and the &ldquo;tax owed now&rdquo; estimate are gated on the
        Phase-2 FIFO tax engine (not built yet). Everything above is decoded on-chain state and
        cost-basis valuation — never a fabricated tax figure.
      </Phase2Note>
    </>
  );
}
