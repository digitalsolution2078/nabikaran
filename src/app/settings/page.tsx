import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { SettingsForm } from "@/components/SettingsForm";
import { readWallet } from "@/lib/core/wallet";
import { ConnectedApps } from "@/components/ConnectedApps";
import { InstallApp } from "@/components/InstallApp";
import { listConnections } from "@/lib/oauth/tokens";
import { formatPhoneLocal } from "@/lib/phone";
import { InviteFriends } from "@/components/InviteFriends";
import { PinManager } from "@/components/PinManager";
import { PushManager } from "@/components/PushManager";
import { referralSummary } from "@/lib/services/referrals";
import { pinStatus } from "@/lib/auth/pin";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const { user, t } = await getRequestContext();
  if (!user) redirect("/login");
  const [connections, ref, pin] = await Promise.all([listConnections(user.id), referralSummary(user.id), pinStatus(user.id)]);
  const link = `${env.appUrl.replace(/\/$/, "")}/r/${ref.code}`;
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
      {ref.settings.enabled && (
        <InviteFriends link={link} referrerCredits={ref.settings.referrer_credits} refereeCredits={ref.settings.referee_credits} minTopup={ref.settings.min_topup_npr}
          message={ref.settings.message} invited={ref.invited} rewarded={ref.rewarded} pending={ref.pending} creditsEarned={ref.creditsEarned} />
      )}
      <PushManager />
      <PinManager initial={pin} />
      <InstallApp variant="card" />
      <ConnectedApps connections={connections} />
    </div>
  );
}
