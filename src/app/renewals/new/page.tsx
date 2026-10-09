import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { RenewalForm } from "@/components/RenewalForm";
import { listDocTemplates } from "@/lib/services/admin-console";

export const dynamic = "force-dynamic";
export const metadata = { title: "Add reminder" };

export default async function NewRenewal({ searchParams }: { searchParams: Promise<{ template?: string }> }) {
  const { user, t } = await getRequestContext();
  if (!user) redirect("/login?next=/renewals/new");
  const { template } = await searchParams;
  const templates = await listDocTemplates(false);
  return (
    <div>
      <div className="page-head"><h1>{t("rem.add")}</h1></div>
      <RenewalForm templates={templates} initialTemplate={template ?? null} />
    </div>
  );
}
