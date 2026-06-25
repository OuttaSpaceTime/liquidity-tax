'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV: Array<{ href: string; label: string; group?: string; beta?: boolean }> = [
  { href: '/', label: 'Overview' },
  { group: 'Positions', href: '/positions', label: 'Current' },
  { href: '/positions/closed', label: 'Last (closed)' },
  { group: 'Activity', href: '/activity', label: 'Last actions' },
  { href: '/transactions', label: 'Transactions' },
  { group: 'Reports', href: '/reports/monthly', label: 'Monthly', beta: true },
  { href: '/reports/yearly', label: 'Yearly', beta: true },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  if (href === '/positions') return pathname === '/positions';
  return pathname === href || pathname.startsWith(href + '/');
}

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sidebar">
      <div className="brand">
        liquidity-tax
        <small>DeFi positions &amp; tax</small>
      </div>
      <nav className="nav">
        {NAV.map((item) => (
          <div key={item.href}>
            {item.group && <div className="nav-group">{item.group}</div>}
            <Link href={item.href} className={isActive(pathname, item.href) ? 'active' : ''}>
              <span>{item.label}</span>
              {item.beta && <span className="beta">Phase 2</span>}
            </Link>
          </div>
        ))}
      </nav>
    </aside>
  );
}
