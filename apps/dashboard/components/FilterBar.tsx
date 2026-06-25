import Link from 'next/link';

export type SP = Record<string, string | string[] | undefined>;

export interface FilterGroup {
  key: string;
  label: string;
  options: Array<{ value: string; label: string }>;
}

function hrefWith(path: string, sp: SP, key: string, value: string | null): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === key || k === 'cursor') continue; // changing a filter resets pagination
    if (typeof v === 'string') params.set(k, v);
  }
  if (value !== null) params.set(key, value);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export function FilterBar({ path, sp, groups }: { path: string; sp: SP; groups: FilterGroup[] }) {
  return (
    <div className="filters">
      {groups.map((g) => {
        const current = typeof sp[g.key] === 'string' ? (sp[g.key] as string) : undefined;
        return (
          <div key={g.key} className="fl-group">
            <span className="fl-label">{g.label}</span>
            <Link className={`fl${current === undefined ? ' active' : ''}`} href={hrefWith(path, sp, g.key, null)}>
              all
            </Link>
            {g.options.map((o) => (
              <Link
                key={o.value}
                className={`fl${current === o.value ? ' active' : ''}`}
                href={hrefWith(path, sp, g.key, o.value)}
              >
                {o.label}
              </Link>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export const CHAIN_GROUP: FilterGroup = {
  key: 'chain',
  label: 'chain',
  options: [
    { value: 'base', label: 'Base' },
    { value: 'solana', label: 'Solana' },
    { value: 'sui', label: 'Sui' },
  ],
};
