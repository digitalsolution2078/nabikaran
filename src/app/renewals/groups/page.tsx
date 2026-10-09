import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { listGroups } from "@/lib/services/groups";
import { GroupsManager } from "@/components/GroupsManager";
import { Icon } from "@/components/Icon";

export const dynamic = "force-dynamic";
export const metadata = { title: "Groups" };

export default async function GroupsPage() {
  const { user, t } = await getRequestContext();
  if (!user) redirect("/login?next=/renewals/groups");
  const groups = await listGroups(user.id);
  return (
    <div>
      <Link href="/renewals" className="small">← {t("rem.title")}</Link>
      <div className="page-head">
        <div><h1>{t("grp.title")}</h1><p>{t("grp.intro")}</p></div>
        <Link className="btn btn-secondary" href="/renewals/import"><Icon name="upload" size={16} /> {t("imp.title")}</Link>
      </div>
      <GroupsManager groups={groups} />
    </div>
  );
}
