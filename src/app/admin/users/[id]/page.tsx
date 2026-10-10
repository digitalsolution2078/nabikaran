import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { getUserDetail, listNotes, listSmsLog, listUserAudit } from "@/lib/services/admin-console";
import { getStatement, listTopups } from "@/lib/services/wallet-report";
import { ChannelBadge } from "@/components/ChannelBadge";
import { NoteForm } from "@/components/admin/NoteForm";
import { StatusBadge } from "@/components/StatusBadge";
import { AdjustCredits, RoleControl } from "@/components/admin/UserControls";
import { formatPhoneLocal } from "@/lib/phone";
import { PlanControl } from "@/components/admin/PlanControl";
import { planHistory } from "@/lib/services/plans";

export const dynamic = "force-dynamic";

export default async function AdminUserDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [me, d] = await Promise.all([getCurrentUser(), getUserDetail(id)]);
  if (!d || !me) notFound();
  const [st, topups, msgs, notes, auditRows, plans] = await Promise.all([getStatement(id, undefined, 100), listTopups(id), listSmsLog(null, 100, undefined, null, id), listNotes(id), listUserAudit(id), planHistory(id)]);
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

      <section className="card">
        <h2>Nabikaran Pro</h2>
        <PlanControl userId={u.id} history={plans} canGrant={can(me.role, "plans.grant")} />
      </section>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section className="card">
          <h2>Credit adjustment</h2>
          {self ? <p className="muted mb-0">You cannot adjust your own wallet.</p> : !can(me.role, "adjustments.request") ? <p className="muted mb-0">Your role cannot adjust credits.</p> : (
            <AdjustCredits userId={u.id} direct={can(me.role, "adjustments.direct")} />
          )}
        </section>
        <section className="card">
          <h2>Role</h2>
          {can(me.role, "roles.manage") && !self ? <RoleControl userId={u.id} role={u.role} /> : <p className="muted mb-0">{self ? "You cannot change your own role." : "Only a Super Admin can change roles."}</p>}
        </section>
      </div>

      <section>
        <h2>Wallet ledger</h2>
        <p className="small muted">Purchased {st.totals.purchased} · SMS {st.totals.spent_sms} · WhatsApp {st.totals.spent_whatsapp} · refunded {st.totals.refunded} · fees {st.totals.fee} · adjustments {st.totals.adjustment} · reversed {st.totals.reversed} → posted {st.wallet.posted} (reserved {st.wallet.reserved})</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Category</th><th>Detail</th><th className="num">Credits</th></tr></thead>
            <tbody>
              {st.rows.map((l) => <tr key={l.id}><td className="nowrap small">{l.createdAt.replace("T", " ").slice(0, 16)}</td><td>{l.category.replace("_", " ")} {l.channel && <ChannelBadge channel={l.channel} />}</td><td className="small muted">{l.description}{l.reference ? ` · ${l.reference.slice(0, 12)}` : ""}</td><td className={`num ${l.credits >= 0 ? "plus" : "minus"}`}>{l.credits > 0 ? "+" : ""}{l.credits}</td></tr>)}
              {st.rows.length === 0 && <tr><td colSpan={4} className="muted">No transactions.</td></tr>}
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
          <h2>Top-ups</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Reference</th><th>Method</th><th className="num">NPR</th><th>Status</th></tr></thead>
              <tbody>
                {topups.map((t) => <tr key={`${t.kind}-${t.id}`}><td className="mono small">{t.reference}<br /><span className="muted">{t.createdAt.slice(0, 10)}</span></td><td className="small">{t.method}</td><td className="num">{t.amountNpr}</td><td><StatusBadge status={t.status} /></td></tr>)}
                {topups.length === 0 && <tr><td colSpan={4} className="muted">None.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section>
        <h2>Message log (SMS + WhatsApp)</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Sent</th><th>Channel</th><th>Reminder</th><th>Status</th><th className="hide-mobile">Provider / report</th></tr></thead>
            <tbody>
              {msgs.map((m) => <tr key={m.attempt_id}><td className="nowrap small">{m.request_at.replace("T", " ").slice(0, 16)}</td><td><ChannelBadge channel={m.channel} /></td><td>{m.label}</td><td><StatusBadge status={m.status} />{m.error_text ? <div className="small muted">{m.error_text}</div> : null}{m.refunded_at ? <div className="small">refunded</div> : null}</td><td className="small muted hide-mobile">{m.provider} · {m.api_state} · {m.reported_status ?? "no report"}</td></tr>)}
              {msgs.length === 0 && <tr><td colSpan={5} className="muted">No messages sent yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="hint">Scheduled messages: <Link href="/admin/messages?status=scheduled">queue</Link>.</p>
      </section>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section className="card">
          <h2>Support notes</h2>
          {can(me.role, "notes.write") ? <NoteForm userId={u.id} /> : <p className="small muted">Your role can read notes but not add them.</p>}
          <div className="list mt">
            {notes.map((n) => <div key={n.id} className="list-item"><span className="grow"><span style={{ whiteSpace: "pre-wrap" }}>{n.body}</span><br /><span className="meta">{n.author_name ?? n.author_phone} · {n.created_at.replace("T", " ").slice(0, 16)} UTC</span></span></div>)}
            {notes.length === 0 && <p className="muted mb-0">No notes.</p>}
          </div>
        </section>
        <section className="card">
          <h2>Audit history</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>When (UTC)</th><th>Action</th><th>By</th></tr></thead>
              <tbody>
                {auditRows.map((e) => <tr key={e.id}><td className="nowrap small">{e.created_at.replace("T", " ").slice(0, 16)}</td><td className="mono small">{e.action}</td><td className="small">{e.actor_phone ?? e.actor_via ?? "system"}</td></tr>)}
                {auditRows.length === 0 && <tr><td colSpan={3} className="muted">No events.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
