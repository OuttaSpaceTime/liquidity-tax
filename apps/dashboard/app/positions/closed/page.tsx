import { getClosedPositions } from '@/lib/queries';
import { Topbar } from '@/components/Topbar';
import { ClosedPositionsTable } from '@/components/ClosedPositionsTable';
import { EmptyState, Phase2Note } from '@/components/atoms';
import { FilterBar, CHAIN_GROUP } from '@/components/FilterBar';
import { PositionTabs } from '@/components/PositionTabs';
import { parseChain, type SP } from '@/lib/params';

export const dynamic = 'force-dynamic';

export default async function ClosedPositionsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const chain = parseChain(sp);
  const positions = await getClosedPositions({ chain });

  return (
    <>
      <Topbar title="Last positions" subtitle={`${positions.length} most-recently closed`} />
      <PositionTabs active="closed" />
      <FilterBar path="/positions/closed" sp={sp} groups={[CHAIN_GROUP]} />

      {positions.length === 0 ? (
        <EmptyState>No closed positions{chain ? ` on ${chain}` : ''}.</EmptyState>
      ) : (
        <>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <ClosedPositionsTable positions={positions} />
          </div>
          <Phase2Note>
            &ldquo;Realized gain&rdquo; and the §23 12-month decision are computed by the Phase-2 FIFO
            engine (per-wallet, per-token, Tausch resets). Until then the §23 column is a held-duration
            hint only.
          </Phase2Note>
        </>
      )}
    </>
  );
}
