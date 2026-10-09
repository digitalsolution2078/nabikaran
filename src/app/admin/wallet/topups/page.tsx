import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { listTopupsForAdmin } from "@/lib/services/manual-topups";
import { getDb } from "@/lib/db";
import { StatusBadge } from "@/components/StatusBadge";
import { TopupDecision, AdjustmentApprove } from "@/components/admin/TopupDecision";
import { formatPhoneLocal } from "@/lib/phone";
import { can } from "@/lib/auth/rbac";

export const dynamic = "force-dynamic";

const TABS = ["pending", "approved", "rejected", "awaiting_payment", "all"] as const;

export default async function AdminTopups({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status: raw } = await searchParams;
  const status = (TABS as readonly string[]).includes(raw ?? "") ? (raw as (typeof TABS)[number]) : "pending";
  const me = await getCurrentUser();
  const [rows, adj, reviewers] = await Promise.all([
    listTopupsForAdmin(status),
    getDb().query<{ id: string; user_id: string; phone_e164: string; signed_credits: string; reason: string; requested_by: string; req_phone: string; created_at: string }>(
      `select a.id, a.user_id, u.phone_e164, a.signed_credits::text, a.reason, a.requested_by, r.phone_e164 as req_phone, a.created_at
         from wallet_adjustment_requests a join users u on u.id = a.user_id join users r on r.id = a.requested_by
        where a.status = 'pending' order by a.created_at`,
    ),
    getDb().query<{ n: string }>("select count(*)::text as n from users where role in ('admin','super_admin','finance') and status = 'active'"),
  ]);
  const reviewerCount = Number(reviewers.rows[0]?.n ?? 0);
  const mayDecide = can(me?.role, "topups.decide");
  const mayApproveAdj = can(me?.role, "adjustments.approve");
  return (
    <div className="stack">
      <div className="alert warn">
        <span><strong>Verify before approving.</strong> Find the payment in the EBL / Fonepay merchant statement (amount and the customer&apos;s reference in remarks), then enter that statement&apos;s transaction reference. A screenshot or the customer&apos;s typed ID alone is not proof of payment. Each statement reference can approve only one request.</span>
      </div>
      {reviewerCount < 2 && (
        <div className="alert bad" role="alert"><span><strong>Add another admin before approving manual top-ups.</strong> Only {reviewerCount} person can review top-ups. Nobody can approve their own request, so a top-up requested by that person will stay pending. Promote a trusted person to <em>Finance reviewer</em> under Users → Role.</span></div>
      )}
      {!mayDecide && <div className="alert info"><span>Your role can view top-ups but not approve or reject them.</span></div>}
      <nav className="admin-tabs" aria-label="Top-up status">
        {TABS.map((s) => <Link key={s} href={`/admin/wallet/topups?status=${s}`} className={s === status ? "active" : ""}>{s.replace("_", " ")}</Link>)}
      </nav>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Customer</th><th>Reference</th><th className="num">NPR</th><th>Customer txn ID</th><th>Submitted</th><th>Status / decision</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/admin/users/${r.userId}`}>{r.userName ?? formatPhoneLocal(r.userPhone)}</Link><br /><span className="small muted">{r.userPhone}</span></td>
                <td className="mono">{r.reference}</td>
                <td className="num"><strong>{r.amountNpr.toLocaleString("en-IN")}</strong><br /><span className="small muted">{r.credits} cr</span></td>
                <td className="mono small">{r.payerTxnRef ?? "—"}{r.payerNote ? <><br /><span className="muted">“{r.payerNote}”</span></> : null}{r.hasReceipt && <><br /><a href={`/api/admin/topups/${r.id}/receipt`} target="_blank" rel="noopener noreferrer">View receipt</a></>}</td>
                <td className="nowrap small">{(r.submittedAt ?? r.createdAt).replace("T", " ").slice(0, 16)}</td>
                <td>
                  <StatusBadge status={r.status} />
                  {r.status === "pending" && mayDecide && r.userId !== me?.id && <TopupDecision id={r.id} reference={r.reference} amount={r.amountNpr} />}
                  {r.status === "pending" && r.userId === me?.id && <p className="small muted">Your own request — another admin must decide.{reviewerCount < 2 ? " Add another admin first." : ""}</p>}
                  {(r.status === "approved" || r.status === "rejected") && (
                    <div className="small muted">{r.verifiedBankRef ? <>bank ref <span className="mono">{r.verifiedBankRef}</span><br /></> : null}by {r.decidedByPhone ?? "?"} · {r.decidedAt?.slice(0, 16).replace("T", " ")}{r.decisionNotes ? <><br />{r.decisionNotes}</> : null}</div>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="muted">No {status.replace("_", " ")} requests.</td></tr>}
          </tbody>
        </table>
      </div>

      <section>
        <h2>Credit adjustment requests (two-person rule)</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Wallet</th><th className="num">Credits</th><th>Reason</th><th>Requested by</th><th /></tr></thead>
            <tbody>
              {adj.rows.map((a) => (
                <tr key={a.id}>
                  <td><Link href={`/admin/users/${a.user_id}`}>{a.phone_e164}</Link></td>
                  <td className={`num ${Number(a.signed_credits) >= 0 ? "plus" : "minus"}`}>{Number(a.signed_credits) > 0 ? "+" : ""}{a.signed_credits}</td>
                  <td className="small">{a.reason}</td>
                  <td className="small">{a.req_phone}<br /><span className="muted">{new Date(a.created_at).toISOString().slice(0, 16).replace("T", " ")}</span></td>
                  <td>{mayApproveAdj && a.requested_by !== me?.id && a.user_id !== me?.id ? <AdjustmentApprove id={a.id} credits={Number(a.signed_credits)} /> : <span className="small muted">needs another admin</span>}</td>
                </tr>
              ))}
              {adj.rows.length === 0 && <tr><td colSpan={5} className="muted">No pending adjustment requests.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
