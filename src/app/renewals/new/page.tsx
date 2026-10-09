import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { RenewalForm } from "@/components/RenewalForm";
import { LockNotice } from "@/components/LockNotice";
import { listDocTemplates } from "@/lib/services/admin-console";
import { getLockState } from "@/lib/core/account-lock";
import { getSetting } from "@/lib/services/settings";

export const dynamic = "force-dynamic";
export const metadata = { title: "Add reminder" };

export default async function NewRenewal({ searchParams }: { searchParams: Promise<{ template?: string }> }) {
  const { user, t, prefs } = await getRequestContext();
  if (!user) redirect("/login?next=/renewals/new");
  const { template } = await searchParams;
  const [templates, lock, limits] = await Promise.all([listDocTemplates(false), getLockState(user.id), getSetting("topup")]);
  return (
    <div>
      <div className="page-head"><h1>{t("rem.add")}</h1></div>
      {lock.locked ? (
        <LockNotice available={lock.available} minBalance={lock.minBalance} lang={prefs.lang} t={t} />
      ) : (
        <RenewalForm templates={templates} initialTemplate={template ?? null} topupMin={limits.min_npr} />
      )}
    </div>
  );
}
