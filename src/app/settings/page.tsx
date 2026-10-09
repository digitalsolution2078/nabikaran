import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { SettingsForm } from "@/components/SettingsForm";
import { readWallet } from "@/lib/core/wallet";
import { ConnectedApps } from "@/components/ConnectedApps";
import { listConnections } from "@/lib/oauth/tokens";
import { formatPhoneLocal } from "@/lib/phone";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const { user, t } = await getRequestContext();
  if (!user) redirect("/login");
  const connections = await listConnections(user.id);
  return (
    <div className="stack">
      <h1>{t("settings.title")}</h1>
      <div className="card">
        <div className="field mb-0">
          <label htmlFor="phone">{t("settings.phone")}</label>
          <input id="phone" type="text" value={`+977 ${formatPhoneLocal(user.phoneE164)}`} readOnly />
          <span className="hint">{t("settings.phoneHint")} · Asia/Kathmandu</span>
        </div>
      </div>
      <SettingsForm displayName={user.displayName ?? ""} smsLanguage={user.locale} balance={(await readWallet(user.id)).posted} />
      <ConnectedApps connections={connections} />
    </div>
  );
}
