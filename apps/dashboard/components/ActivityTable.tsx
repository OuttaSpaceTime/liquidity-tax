import Link from 'next/link';
import type { ActivityDTO } from '@/lib/queries';
import { ChainBadge, ProtocolBadge, WalletLabel, AmountView, VerbBadge, FlagPills, TxLink, Eur } from './atoms';
import { formatDateTime } from '@/lib/format';

export function ActivityTable({ items, showWallet = true }: { items: ActivityDTO[]; showWallet?: boolean }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Chain</th>
          <th>Action</th>
          {showWallet && <th>Wallet</th>}
          <th>Sent</th>
          <th>Received</th>
          <th className="num">€ value</th>
          <th>Position</th>
          <th>Tx</th>
          <th>Flags</th>
        </tr>
      </thead>
      <tbody>
        {items.map((e) => (
          <tr key={e.id}>
            <td className="nowrap mono faint">{formatDateTime(e.timestamp)}</td>
            <td><ChainBadge chain={e.chain} /></td>
            <td>
              <VerbBadge verb={e.verb} /> <ProtocolBadge protocol={e.protocol} />
            </td>
            {showWallet && (
              <td>
                <WalletLabel label={e.walletLabel} />
              </td>
            )}
            <td>{e.sent ? <AmountView amount={e.sent} /> : <span className="faint">—</span>}</td>
            <td>{e.received ? <AmountView amount={e.received} /> : <span className="faint">—</span>}</td>
            <td className="num">
              <Eur value={e.eurValue} />
            </td>
            <td>
              {e.positionId ? (
                <Link href={`/positions/${encodeURIComponent(e.positionId)}`} className="mono dim" style={{ fontSize: 11 }}>
                  {e.protocol}
                </Link>
              ) : (
                <span className="faint">—</span>
              )}
            </td>
            <td><TxLink chain={e.chain} txHash={e.txHash} /></td>
            <td><FlagPills flags={e.flags} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
