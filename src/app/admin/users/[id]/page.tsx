import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { getUserDetail } from "@/lib/services/admin-console";
import { StatusBadge } from "@/components/StatusBadge";
import { AdjustCredits, RoleControl } from "@/components/admin/UserControls";
import { formatPhoneLocal } from "@/lib/phone";

export const dynamic = "force-dynamic";

export default async function AdminUserDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [me, d] = await Promise.all([getCurrentUser(), getUserDetail(id)]);
  if (!d || !me) notFound();
  const u = d.user;
  const self = me.id === u.id;
  return (
    <div className="stack">
      <Link href="/admin/users" className="small">← Users</Link>
      <section className="card">
        <div className="row between">
          <div><h2 className="mb-0">{u.name ?? formatPhoneLocal(u.phone)}</h2><span className="small muted">{u.phone}{u.email ? ` · ${u.email}` : ""} · joined {u.createdAt.slice(0, 10)}</span></div>
          <span className="row"><StatusBadge status={u.role} /><StatusBadge status={u.status} /></span>
        </div>
        <div className="grid grid-3 mt">
          <div className="stat"><div className="label">Available credits</div><div className="value">{u.available}</div></div>
          <div className="stat"><div className="label">Reserved</div><div className="value">{u.reserved}</div></div>
          <div className="stat"><div className="label">Active reminders</div><div className="value">{u.activeReminders}</div></div>
        </div>
      </section>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section className="card">
          <h2>Credit adjustment</h2>
          {self ? <p className="muted mb-0">You cannot adjust your own wallet.</p> : (
            <AdjustCredits userId={u.id} direct={can(me.role, "adjustments.direct")} />
          )}
        </section>
        <section className="card">
          <h2>Role</h2>
          {can(me.role, "roles.manage") && !self ? <RoleControl userId={u.id} role={u.role} /> : <p className="muted mb-0">{self ? "You cannot change your own role." : "Only a Super Admin can change roles."}</p>}
        </section>
      </div>

      <section>
        <h2>Wallet transactions</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Type</th><th>Reference / memo</th><th className="num">Credits</th></tr></thead>
            <tbody>
              {d.ledger.map((l) => <tr key={l.id}><td className="nowrap">{l.createdAt.replace("T", " ").slice(0, 16)}</td><td>{l.type}</td><td className="small muted">{l.memo ?? l.referenceType}</td><td className={`num ${l.credits >= 0 ? "plus" : "minus"}`}>{l.credits > 0 ? "+" : ""}{l.credits}</td></tr>)}
              {d.ledger.length === 0 && <tr><td colSpan={4} className="muted">No transactions.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section>
          <h2>Reminders</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Label</th><th>Expiry (UTC)</th><th>Status</th></tr></thead>
              <tbody>
                {d.reminders.map((r) => <tr key={r.id}><td>{r.label}<br /><span className="small muted">{r.category}</span></td><td className="nowrap">{r.expiryAtUtc.slice(0, 10)}</td><td><StatusBadge status={r.status} /></td></tr>)}
                {d.reminders.length === 0 && <tr><td colSpan={3} className="muted">None.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="hint">Reminder content is the customer&apos;s; manage it only when they ask or for abuse/billing investigations.</p>
        </section>
        <section>
          <h2>QR top-ups</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Reference</th><th className="num">NPR</th><th>Status</th></tr></thead>
              <tbody>
                {d.topups.map((t) => <tr key={t.id}><td className="mono">{t.reference}<br /><span className="small muted">{t.createdAt.slice(0, 10)}</span></td><td className="num">{t.amountNpr}</td><td><StatusBadge status={t.status} /></td></tr>)}
                {d.topups.length === 0 && <tr><td colSpan={3} className="muted">None.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section>
        <h2>SMS log</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Due</th><th>Reminder</th><th>Status</th><th className="hide-mobile">Attempts / error</th></tr></thead>
            <tbody>
              {d.sms.map((s) => <tr key={s.id}><td className="nowrap">{s.dueAtUtc.replace("T", " ").slice(0, 16)}</td><td>{s.label}</td><td><StatusBadge status={s.status} /></td><td className="small muted hide-mobile">{s.attempts}{s.lastError ? ` · ${s.lastError}` : ""}</td></tr>)}
              {d.sms.length === 0 && <tr><td colSpan={4} className="muted">None.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
