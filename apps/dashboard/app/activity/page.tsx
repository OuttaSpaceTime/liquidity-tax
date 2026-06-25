import Link from 'next/link';
import { getActivity } from '@/lib/queries';
import { Topbar } from '@/components/Topbar';
import { ActivityTable } from '@/components/ActivityTable';
import { EmptyState } from '@/components/atoms';
import { FilterBar, CHAIN_GROUP, type FilterGroup } from '@/components/FilterBar';
import { parseChain, parseType, type SP } from '@/lib/params';

export const dynamic = 'force-dynamic';

const TYPE_GROUP: FilterGroup = {
  key: 'type',
  label: 'type',
  options: [
    { value: 'swap', label: 'swaps' },
    { value: 'lp_deposit', label: 'lp in' },
    { value: 'lp_withdraw', label: 'lp out' },
    { value: 'lp_fee', label: 'fees' },
    { value: 'lp_reward', label: 'rewards' },
    { value: 'lend_borrow', label: 'borrow' },
    { value: 'lend_supply', label: 'supply' },
    { value: 'transfer', label: 'transfers' },
    { value: 'unknown', label: 'unknown' },
  ],
};

function parseCount(sp: SP): number {
  const n = typeof sp.count === 'string' ? parseInt(sp.count, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 50;
}

export default async function ActivityPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const chain = parseChain(sp);
  const type = parseType(sp);
  const count = parseCount(sp);
  const { items, nextCursor } = await getActivity({ chain, type }, null, count);

  const moreParams = new URLSearchParams();
  if (chain) moreParams.set('chain', chain);
  if (type) moreParams.set('type', type);
  moreParams.set('count', String(count + 50));

  return (
    <>
      <Topbar title="Last actions" subtitle="Decoded events, newest first" />
      <FilterBar path="/activity" sp={sp} groups={[CHAIN_GROUP, TYPE_GROUP]} />

      {items.length === 0 ? (
        <EmptyState hint={<span className="faint">Run the CLI ingest + decode to populate events.</span>}>
          No activity matches these filters.
        </EmptyState>
      ) : (
        <>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <ActivityTable items={items} />
          </div>
          {nextCursor && (
            <Link className="loadmore" href={`/activity?${moreParams.toString()}`}>
              Show more ({count} shown)
            </Link>
          )}
        </>
      )}
    </>
  );
}
