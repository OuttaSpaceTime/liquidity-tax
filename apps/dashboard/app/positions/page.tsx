import { getOpenPositions } from '@/lib/queries';
import { Topbar } from '@/components/Topbar';
import { PositionCard } from '@/components/PositionCard';
import { EmptyState } from '@/components/atoms';
import { FilterBar, CHAIN_GROUP } from '@/components/FilterBar';
import { PositionTabs } from '@/components/PositionTabs';
import { parseChain, type SP } from '@/lib/params';

export const dynamic = 'force-dynamic';

export default async function PositionsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const chain = parseChain(sp);
  const positions = await getOpenPositions({ chain });

  return (
    <>
      <Topbar title="Current positions" subtitle={`${positions.length} open`} />
      <PositionTabs active="current" />
      <FilterBar path="/positions" sp={sp} groups={[CHAIN_GROUP]} />

      {positions.length === 0 ? (
        <EmptyState hint={<span className="faint">Open positions are derived from decoded events.</span>}>
          No open positions{chain ? ` on ${chain}` : ''}.
        </EmptyState>
      ) : (
        <div className="grid cards">
          {positions.map((p) => (
            <PositionCard key={p.positionId} position={p} />
          ))}
        </div>
      )}
    </>
  );
}
