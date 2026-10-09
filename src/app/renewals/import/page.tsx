import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { listGroups } from "@/lib/services/groups";
import { getLockState } from "@/lib/core/account-lock";
import { getSetting } from "@/lib/services/settings";
import { BulkImport } from "@/components/BulkImport";
import { LockNotice } from "@/components/LockNotice";

export const dynamic = "force-dynamic";
export const metadata = { title: "Import reminders" };

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ group?: string }> }) {
  const { user, t, prefs } = await getRequestContext();
  if (!user) redirect("/login?next=/renewals/import");
  const { group } = await searchParams;
  const [groups, lock, limits] = await Promise.all([listGroups(user.id), getLockState(user.id), getSetting("topup")]);
  return (
    <div>
      <Link href="/renewals/groups" className="small">← {t("grp.title")}</Link>
      <div className="page-head"><div><h1>{t("imp.title")}</h1><p>{t("imp.intro")}</p></div></div>
      {lock.locked ? (
        <LockNotice available={lock.available} minBalance={lock.minBalance} lang={prefs.lang} t={t} />
      ) : (
        <BulkImport groups={groups} initialGroupId={group ?? null} topupMin={limits.min_npr} />
      )}
    </div>
  );
}
