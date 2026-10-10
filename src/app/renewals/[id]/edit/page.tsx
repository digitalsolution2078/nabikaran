import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { webPrincipal } from "@/lib/core/principal";
import { getReminder } from "@/lib/core/reminders";
import { getLockState } from "@/lib/core/account-lock";
import { listDocTemplates } from "@/lib/services/admin-console";
import { getSetting } from "@/lib/services/settings";
import { whatsappAvailable } from "@/lib/whatsapp/availability";
import { getDb } from "@/lib/db";
import { emailReminderAvailable } from "@/lib/services/email-auth";
import { listGroups } from "@/lib/services/groups";
import { RenewalForm } from "@/components/RenewalForm";
import { LockNotice } from "@/components/LockNotice";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit reminder" };

export default async function EditRenewal({ params }: { params: Promise<{ id: string }> }) {
  const { user, t, prefs } = await getRequestContext();
  const { id } = await params;
  if (!user) redirect(`/login?next=/renewals/${id}/edit`);
  const r = await getReminder(webPrincipal(user), id).catch(() => null);
  if (!r) notFound();
  const [templates, lock, limits, waOk, opt, groups, rules] = await Promise.all([
    listDocTemplates(false),
    getLockState(user.id),
    getSetting("topup"),
    whatsappAvailable(),
    getDb().query<{ at: string | null }>("select whatsapp_opt_in_at as at from users where id = $1", [user.id]),
    listGroups(user.id),
    getDb().query<{ offset_minutes: number }>("select offset_minutes from reminder_rules where renewal_id = $1 and enabled", [r.id]),
  ]);
  const whatsapp = { available: waOk, optedIn: Boolean(opt.rows[0]?.at) };
  return (
    <div>
      <Link href={`/renewals/${r.id}`} className="small">← {r.label}</Link>
      <div className="page-head"><div><h1>{t("rem.editTitle")}</h1><p>{t("rem.editNote")}</p></div></div>
      {lock.locked ? (
        <LockNotice available={lock.available} minBalance={lock.minBalance} lang={prefs.lang} t={t} />
      ) : (
        <RenewalForm
          templates={templates}
          renewalId={r.id}
          topupMin={limits.min_npr}
          whatsapp={whatsapp}
          emailAvailable={await emailReminderAvailable(user.id)}
          groups={groups}
          initial={{
            category: r.category,
            label: r.label,
            calendar: r.inputCalendar,
            expiryDate: r.inputDate ?? r.expiry.ad,
            localTime: r.localTime,
            notes: r.notes ?? "",
            familyMemberLabel: r.familyMemberLabel ?? "",
            // Yearly reminders keep offsets that are already past this year; read them from the rules.
            offsets: (r.repeatYearly || r.repeatMonths) && rules.rows.length ? rules.rows.map((x) => x.offset_minutes) : [...new Set(r.jobs.filter((j) => j.status !== "cancelled").map((j) => j.offsetMinutes))],
            templateSlug: r.templateSlug,
            channels: r.channels,
            groupId: r.groupId,
            repeatYearly: r.repeatYearly,
          }}
        />
      )}
    </div>
  );
}
