import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { businessName, familySigner, listClients } from "@/lib/services/clients";
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
  if (!name && settings.family_max <= 0) {
    return (
      <div className="stack">
        <h1>{t("clients.title")}</h1>
        {settings.enabled ? <BusinessCard initial={null} /> : <p className="muted">{t("biz.unavailable")}</p>}
      </div>
    );
  }
  const clients = await listClients(user.id);
  const n = String(settings.family_max);
  return (
    <div className="stack">
      <div className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>{name ? t("clients.title") : t("fam.title")}</h1>
          <p className="muted mb-0">{name ? t("clients.lead", { business: name }) : t("fam.lead", { n })}</p>
        </div>
        {name && <Link href="/renewals/import" className="btn btn-secondary"><Icon name="upload" /> {t("clients.import")}</Link>}
      </div>
      {!name && clients.length >= settings.family_max && <div className="alert info"><Icon name="info" /> <span>{t("fam.limit", { n })}</span></div>}
      <ClientsManager initial={clients.map((c) => ({ id: c.id, name: c.name, phone: c.phone, note: c.note, activeReminders: c.activeReminders, nextDue: c.nextDue }))} businessName={name ?? familySigner(user.displayName)} family={!name} />
    </div>
  );
}
