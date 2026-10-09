import Link from "next/link";
import { listAudit } from "@/lib/services/admin-console";

export const dynamic = "force-dynamic";

const PREFIXES = ["", "wallet.", "rbac.", "settings.", "sms.", "templates.", "reminder.", "oauth.", "mcp.", "auth.", "payment."];

export default async function AdminAudit({ searchParams }: { searchParams: Promise<{ action?: string }> }) {
  const { action = "" } = await searchParams;
  const rows = await listAudit({ action: PREFIXES.includes(action) ? action : "", limit: 300 });
  return (
    <div className="stack">
      <p className="small muted">Append-only: the database refuses updates and deletes on this log. Phone numbers in details are redacted where they originate.</p>
      <nav className="admin-tabs">{PREFIXES.map((p) => <Link key={p || "all"} href={`/admin/audit?action=${p}`} className={p === action ? "active" : ""}>{p || "all"}</Link>)}</nav>
      <div className="table-wrap">
        <table>
          <thead><tr><th>#</th><th>When (UTC)</th><th>Action</th><th>Actor</th><th>Target</th><th className="hide-mobile">Detail</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="small muted">{r.id}</td>
                <td className="nowrap small">{r.created_at.replace("T", " ").slice(0, 19)}</td>
                <td className="mono small">{r.action}</td>
                <td className="small">{r.actor_phone ?? r.actor_via}{r.actor_client_id ? <><br /><span className="muted">{r.actor_client_id}</span></> : null}</td>
                <td className="small">{r.target_type}{r.target_id ? <><br /><span className="mono muted">{String(r.target_id).slice(0, 12)}</span></> : null}</td>
                <td className="small mono hide-mobile" style={{ maxWidth: 360, wordBreak: "break-word" }}>{r.json_detail_redacted ? JSON.stringify(r.json_detail_redacted).slice(0, 240) : ""}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="muted">No entries.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
