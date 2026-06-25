import { Topbar } from '@/components/Topbar';
import { StatTile, Phase2Note } from '@/components/atoms';

export const dynamic = 'force-dynamic';

export default function MonthlyReportPage() {
  return (
    <>
      <Topbar title="Monthly report" subtitle="YTD running tax state" />
      <Phase2Note>
        This report is gated on the Phase-2 FIFO tax engine (per-wallet/per-token lots, §23 disposals,
        §22 income buckets, Freigrenzen, §32a). The schema and pipeline below it are built; the engine is
        not. No partial or fabricated tax figures are shown.
      </Phase2Note>
      <div className="grid cols-3">
        <StatTile label="Realized §23 gains (YTD)" value="—" hint="needs disposals table" phase2 />
        <StatTile label="§22 income (YTD)" value="—" hint="needs tax engine" phase2 />
        <StatTile label="Freigrenze €1.000 / €256" value="—" hint="cliff status" phase2 />
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h3>What this will show</h3>
        <ul className="dim" style={{ lineHeight: 1.8 }}>
          <li>Realized §23 gains/losses per month (per-wallet, per-token FIFO).</li>
          <li>§22 Nr. 3 income YTD (LP fees, rewards, lending) at Marktkurs on Zufluss.</li>
          <li>Freigrenze status meters (both cliff branches per BMF 06.03.2025).</li>
          <li>Holding-period watchlist — lots crossing the 12-month line soon.</li>
        </ul>
      </div>
    </>
  );
}
