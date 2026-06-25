import Link from 'next/link';
import { getTransactions } from '@/lib/queries';
import { Topbar } from '@/components/Topbar';
import { ActivityTable } from '@/components/ActivityTable';
import { ChainBadge, TxLink, EmptyState } from '@/components/atoms';
import { FilterBar, CHAIN_GROUP } from '@/components/FilterBar';
import { parseChain, type SP } from '@/lib/params';
import { formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

function parseCount(sp: SP): number {
  const n = typeof sp.count === 'string' ? parseInt(sp.count, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 40;
}

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const chain = parseChain(sp);
  const count = parseCount(sp);
  const txs = await getTransactions({ chain }, count);

  const more = new URLSearchParams();
  if (chain) more.set('chain', chain);
  more.set('count', String(count + 40));

  return (
    <>
      <Topbar title="Transactions" subtitle="Every decoded tx as event rows (audit view)" />
      <FilterBar path="/transactions" sp={sp} groups={[CHAIN_GROUP]} />

      {txs.length === 0 ? (
        <EmptyState>No transactions{chain ? ` on ${chain}` : ''}.</EmptyState>
      ) : (
        <>
          <div className="grid" style={{ gap: 8 }}>
            {txs.map((t) => (
              <details className="card tx" key={`${t.chain}:${t.txHash}`} style={{ padding: 12 }}>
                <summary>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
                    <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <ChainBadge chain={t.chain} />
                      <TxLink chain={t.chain} txHash={t.txHash} />
                      <span className="faint">{t.eventCount} events</span>
                    </span>
                    <span className="faint mono">{formatDateTime(t.timestamp)}</span>
                  </div>
                </summary>
                <div style={{ marginTop: 10, overflowX: 'auto' }}>
                  <ActivityTable items={t.events} showWallet={false} />
                </div>
              </details>
            ))}
          </div>
          {txs.length >= count && (
            <Link className="loadmore" href={`/transactions?${more.toString()}`}>
              Show more ({count} shown)
            </Link>
          )}
        </>
      )}
    </>
  );
}
