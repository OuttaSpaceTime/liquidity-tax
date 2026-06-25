import Link from 'next/link';
import type { PositionDTO } from '@/lib/queries';
import { ChainBadge, ProtocolBadge, WalletLabel, Amounts, Eur } from './atoms';
import { formatDate } from '@/lib/format';

function taxHint(p: PositionDTO) {
  if (p.holdingDays === null) return <span className="faint">—</span>;
  return p.holdingDays < 365 ? (
    <span className="pill warn" title="Held < 12 months — §23 may apply (gain is Phase-2).">
      § 23 &lt; 1y
    </span>
  ) : (
    <span className="pill in" title="Held ≥ 12 months — likely outside §23.">
      ≥ 1y
    </span>
  );
}

export function ClosedPositionsTable({ positions }: { positions: PositionDTO[] }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Position</th>
          <th>Wallet</th>
          <th>Deposited</th>
          <th>Withdrawn</th>
          <th>Harvested €</th>
          <th className="num">Held</th>
          <th>§23?</th>
          <th>Realized gain €</th>
          <th className="num">Closed</th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => (
          <tr key={p.positionId}>
            <td>
              <Link href={`/positions/${encodeURIComponent(p.positionId)}`}>
                <ProtocolBadge protocol={p.protocol} /> <ChainBadge chain={p.chain} />
              </Link>
            </td>
            <td><WalletLabel label={p.walletLabel} /></td>
            <td><Amounts items={p.deposited} /></td>
            <td><Amounts items={p.withdrawn} /></td>
            <td className="mono"><Eur value={p.harvestedEur} /></td>
            <td className="num">{p.holdingDays ?? '—'}d</td>
            <td>{taxHint(p)}</td>
            <td>
              <span className="pill neutral" title="Requires the Phase-2 FIFO tax engine.">
                pending engine
              </span>
            </td>
            <td className="num faint mono">{p.closedAt ? formatDate(p.closedAt) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
