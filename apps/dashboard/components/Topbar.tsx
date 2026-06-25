import { getFreshness } from '@/lib/queries';
import { formatDateTime } from '@/lib/format';

export function Topbar({ title, subtitle }: { title: string; subtitle?: string }) {
  const { lastIngestAt, lastEventAt } = getFreshness();
  return (
    <div className="topbar">
      <div>
        <h1>{title}</h1>
        {subtitle && <div className="sub">{subtitle}</div>}
      </div>
      <div className="freshness">
        <div>last ingest: {lastIngestAt ? formatDateTime(lastIngestAt) : '—'}</div>
        <div>last event: {lastEventAt ? formatDateTime(lastEventAt) : '—'}</div>
        <div className="ro">● readonly</div>
      </div>
    </div>
  );
}
