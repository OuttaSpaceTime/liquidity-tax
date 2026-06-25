import { Topbar } from '@/components/Topbar';
import { StatTile, Phase2Note } from '@/components/atoms';

export const dynamic = 'force-dynamic';

export default function YearlyReportPage() {
  return (
    <>
      <Topbar title="Yearly report" subtitle="§23 / §22 breakdown" />
      <Phase2Note>
        Gated on the Phase-2 FIFO tax engine. Year-end semantics (actual Freigrenze crossing, §10d loss
        carryover, Rz-48a unclaimed-reward sweep, §32a marginal rate) require the disposals + tax_lots
        tables that are not built yet.
      </Phase2Note>
      <div className="grid cols-3">
        <StatTile label="§23 net gain" value="—" phase2 />
        <StatTile label="§22 Nr. 3 income" value="—" phase2 />
        <StatTile label="Estimated tax (§32a)" value="—" phase2 />
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h3>What this will show</h3>
        <ul className="dim" style={{ lineHeight: 1.8 }}>
          <li>§23 / §22 breakdown for the selected tax year, per asset and per wallet.</li>
          <li>Loss netting / §10d carryover; §22 Nr. 3 losses ring-fenced.</li>
          <li>Year-end unclaimed-reward recognition (Rz 48a).</li>
          <li>Exportable report (own format; Koinly CSV was dropped 2026-06-10).</li>
        </ul>
      </div>
    </>
  );
}
