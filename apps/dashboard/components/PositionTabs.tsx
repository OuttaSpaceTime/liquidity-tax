import Link from 'next/link';

export function PositionTabs({ active }: { active: 'current' | 'closed' }) {
  return (
    <div className="filters">
      <div className="fl-group">
        <Link className={`fl${active === 'current' ? ' active' : ''}`} href="/positions">
          Current
        </Link>
        <Link className={`fl${active === 'closed' ? ' active' : ''}`} href="/positions/closed">
          Closed
        </Link>
      </div>
    </div>
  );
}
