import type { ActivityDTO } from '@/lib/queries';
import { AmountView, VerbBadge, FlagPills, TxLink, Eur } from './atoms';
import { formatDateTime } from '@/lib/format';

export function Timeline({ items }: { items: ActivityDTO[] }) {
  return (
    <div className="timeline">
      {items.map((e) => (
        <div className="ev" key={e.id}>
          <div className="when">{formatDateTime(e.timestamp)}</div>
          <div>
            <div>
              <VerbBadge verb={e.verb} /> <TxLink chain={e.chain} txHash={e.txHash} />{' '}
              <FlagPills flags={e.flags} />
            </div>
            <div className="dim" style={{ fontSize: 12, marginTop: 2 }}>
              {e.sent && (
                <>
                  sent <AmountView amount={e.sent} />{' '}
                </>
              )}
              {e.received && (
                <>
                  received <AmountView amount={e.received} />{' '}
                </>
              )}
              {e.eurValue !== null && (
                <>
                  · <Eur value={e.eurValue} />
                </>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
