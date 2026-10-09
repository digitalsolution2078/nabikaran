import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { webPrincipal } from "@/lib/core/principal";
import { getReminder } from "@/lib/core/reminders";
import { StatusBadge } from "@/components/StatusBadge";
import { RenewalActions } from "@/components/RenewalActions";
import { RenewalForm } from "@/components/RenewalForm";
import { describeOffset } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

export default async function RenewalDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const r = await getReminder(webPrincipal(user), id).catch(() => null);
  if (!r) notFound();
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{r.label}</h1>
        <StatusBadge status={r.status} />
      </div>
      <p className="muted">
        {r.category} · expires {r.expiry.local} NPT{r.expiry.bs ? ` (${r.expiry.bs.display})` : ""}
        {r.inputCalendar === "BS" && ` · entered as BS ${r.inputDate}`} · cycle {r.cycleNo}
      </p>
      <RenewalActions id={r.id} status={r.status} />
      <h2>Reminders (this cycle)</h2>
      <table>
        <thead><tr><th>When</th><th>Est. credits</th><th>Status</th></tr></thead>
        <tbody>
          {r.jobs.map((j) => (
            <tr key={j.id}>
              <td>{j.due.local}<br /><span className="muted">{describeOffset(j.offsetMinutes)}</span></td>
              <td>{j.estimatedCredits}</td>
              <td><StatusBadge status={j.status} />{j.lastError && j.status === "failed" && <div className="muted" style={{ fontSize: 12 }}>{j.lastError}</div>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Edit</h2>
      <p className="muted" style={{ fontSize: 13 }}>Saving starts a new cycle: unsent reminders are cancelled and re-planned; sent ones stay in history.</p>
      <RenewalForm
        renewalId={r.id}
        initial={{
          category: r.category,
          label: r.label,
          calendar: r.inputCalendar,
          expiryDate: r.inputDate ?? r.expiry.ad,
          localTime: r.localTime,
          notes: r.notes ?? "",
          familyMemberLabel: r.familyMemberLabel ?? "",
          offsets: r.jobs.filter((j) => j.status !== "cancelled").map((j) => j.offsetMinutes),
        }}
      />
    </div>
  );
}
