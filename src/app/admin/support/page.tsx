import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { listTicketsForStaff, supportCounts, SUPPORT_CATEGORIES, type SupportCategory, type SupportStatus } from "@/lib/services/support";

export const dynamic = "force-dynamic";
export const metadata = { title: "Support" };

const STATUS_TABS: [string, string][] = [["active", "Needs attention"], ["open", "Open"], ["waiting_customer", "Waiting for customer"], ["resolved", "Resolved"], ["closed", "Closed"], ["all", "All"]];
const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export default async function AdminSupport({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireAdminPage("support.manage");
  const sp = await searchParams;
  const status = (STATUS_TABS.some(([k]) => k === sp.status) ? sp.status : "active") as SupportStatus | "active" | "all";
  const category = SUPPORT_CATEGORIES.includes(sp.category as SupportCategory) ? (sp.category as SupportCategory) : null;
  const [rows, counts] = await Promise.all([listTicketsForStaff({ status, category, q: sp.q ?? null }), supportCounts()]);
  const qs = (patch: Record<string, string | null>) => {
    const u = new URLSearchParams();
    const merged = { status, category, q: sp.q ?? null, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) u.set(k, v);
    return `/admin/support?${u.toString()}`;
  };
  return (
    <div className="stack">
      <div className="stat-grid">
        <div className="stat"><div className="label">Open</div><div className="value">{counts.open}</div></div>
        <div className="stat"><div className="label">Waiting for customer</div><div className="value">{counts.waiting}</div></div>
        <div className="stat"><div className="label">Showing</div><div className="value">{rows.length}</div></div>
      </div>
      <div className="row">
        {STATUS_TABS.map(([k, label]) => <Link key={k} href={qs({ status: k })} className={`chip ${k === status ? "chip-on" : ""}`} aria-pressed={k === status}>{label}</Link>)}
      </div>
      <form className="row" action="/admin/support">
        <input type="hidden" name="status" value={status} />
        <select name="category" defaultValue={category ?? ""} style={{ width: "auto" }} aria-label="Category">
          <option value="">All categories</option>
          {SUPPORT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input type="search" name="q" defaultValue={sp.q ?? ""} placeholder="Ticket no., name, phone or subject" style={{ maxWidth: 320 }} aria-label="Search" />
        <button className="btn btn-secondary btn-sm">Filter</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Ticket</th><th>Customer</th><th>Category</th><th>Status</th><th>Last customer message</th><th>Assigned</th></tr></thead>
          <tbody>
            {rows.map((k) => (
              <tr key={k.id}>
                <td><Link href={`/admin/support/${k.id}`}><strong>{k.ref}</strong> {k.subject}</Link>{k.priority === "high" && <> <span className="badge bad">high</span></>}</td>
                <td>{k.customer.name ?? "—"}<br /><span className="small muted">{k.customer.phone ?? k.customer.email ?? ""}{k.customer.guest ? " · visitor" : ""}</span></td>
                <td className="small">{k.category}</td>
                <td><span className={`badge ${k.status === "open" ? "info" : k.status === "waiting_customer" ? "warn" : k.status === "resolved" ? "ok" : ""}`}>{k.status.replace("_", " ")}</span></td>
                <td className="small nowrap">{ago(k.lastCustomerAt)}</td>
                <td className="small">{k.assignedTo ?? "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="muted">No tickets here.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
