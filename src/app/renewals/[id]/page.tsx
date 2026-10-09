import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getRenewal } from "@/lib/services/renewals";
import { StatusBadge } from "@/components/StatusBadge";
import { RenewalActions } from "@/components/RenewalActions";
import { RenewalForm } from "@/components/RenewalForm";
import { formatKathmandu } from "@/lib/time";
import { describeOffset } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

export default async function RenewalDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const data = await getRenewal(user.id, id).catch(() => null);
  if (!data) notFound();
  const { renewal, jobs } = data;
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{renewal.label}</h1>
        <StatusBadge status={renewal.status} />
      </div>
      <p className="muted">
        {renewal.category} · expires {formatKathmandu(new Date(renewal.expiry_at_utc))} NPT
        {renewal.date_input_calendar === "BS" && ` (entered as BS ${renewal.date_input_raw})`} · cycle {renewal.cycle_no}
      </p>
      <RenewalActions id={renewal.id} status={renewal.status} />
      <h2>Reminders (this cycle)</h2>
      <table>
        <thead><tr><th>When</th><th>Est. credits</th><th>Status</th></tr></thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>{formatKathmandu(new Date(j.due_at_utc))}<br /><span className="muted">{describeOffset(j.offset_minutes ?? 0)}</span></td>
              <td>{String(j.estimated_credits)}</td>
              <td><StatusBadge status={j.status} />{j.last_error && j.status === "failed" && <div className="muted" style={{ fontSize: 12 }}>{j.last_error}</div>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Edit</h2>
      <p className="muted" style={{ fontSize: 13 }}>Saving starts a new cycle: unsent reminders are cancelled and re-planned; sent ones stay in history.</p>
      <RenewalForm
        renewalId={renewal.id}
        initial={{
          category: renewal.category,
          label: renewal.label,
          calendar: renewal.date_input_calendar,
          expiryDate: renewal.date_input_raw ?? renewal.expiry_at_utc.slice(0, 10),
          localTime: renewal.local_time,
          notes: renewal.notes ?? "",
          familyMemberLabel: renewal.family_member_label ?? "",
          offsets: jobs.filter((j) => j.status !== "cancelled").map((j) => j.offset_minutes ?? 0),
        }}
      />
    </div>
  );
}
