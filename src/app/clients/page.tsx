import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { businessName, listClients } from "@/lib/services/clients";
import { getSetting } from "@/lib/services/settings";
import { ClientsManager } from "@/components/ClientsManager";
import { BusinessCard } from "@/components/BusinessCard";
import { Icon } from "@/components/Icon";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clients" };

/** Business accounts: reminders for your clients (dealers, insurance agents, consultancies). */
export default async function ClientsPage() {
  const { user, t } = await getRequestContext();
  if (!user) redirect("/login");
  const [name, settings] = await Promise.all([businessName(user.id), getSetting("business")]);
  if (!name) {
    return (
      <div className="stack">
        <h1>{t("clients.title")}</h1>
        {settings.enabled ? <BusinessCard initial={null} /> : <p className="muted">{t("biz.unavailable")}</p>}
      </div>
    );
  }
  const clients = await listClients(user.id);
  return (
    <div className="stack">
      <div className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>{t("clients.title")}</h1>
          <p className="muted mb-0">{t("clients.lead", { business: name })}</p>
        </div>
        <Link href="/renewals/import" className="btn btn-secondary"><Icon name="upload" /> {t("clients.import")}</Link>
      </div>
      <ClientsManager initial={clients.map((c) => ({ id: c.id, name: c.name, phone: c.phone, note: c.note, activeReminders: c.activeReminders, nextDue: c.nextDue }))} businessName={name} />
    </div>
  );
}
