import Link from "next/link";
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
import { TwoFactorManager } from "@/components/TwoFactorManager";
import { SessionsCard } from "@/components/SessionsCard";
import { twoFactorStatus, staffNeedsTwoFactor } from "@/lib/services/two-factor";
import { PushManager } from "@/components/PushManager";
import { NudgesToggle } from "@/components/NudgesToggle";
import { BusinessCard } from "@/components/BusinessCard";
import { businessAllowed, businessName } from "@/lib/services/clients";
import { getSetting } from "@/lib/services/settings";
import { getDb } from "@/lib/db";
import { EmailManager } from "@/components/EmailManager";
import { CalendarSync } from "@/components/CalendarSync";
import { getCalendarLink } from "@/lib/services/calendar";
import { getProPrefs, isPro } from "@/lib/services/plans";
import { emailStatus } from "@/lib/services/email-auth";
import { referralSummary } from "@/lib/services/referrals";
import { pinStatus } from "@/lib/auth/pin";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const { user, t } = await getRequestContext();
  if (!user) redirect("/login");
  const [connections, ref, pin, pro, email, proPrefs] = await Promise.all([listConnections(user.id), referralSummary(user.id), pinStatus(user.id), isPro(user.id), emailStatus(user.id), getProPrefs(user.id)]);
  const calendar = pro ? await getCalendarLink(user.id) : null;
  const tfa = await twoFactorStatus(user.id);
  const staffMust = await staffNeedsTwoFactor(user);
  const link = `${env.appUrl.replace(/\/$/, "")}/r/${ref.code}`;
  // The "first reminder" tips only matter until the first reminder exists.
  const { rows: nudgeRows } = await getDb().query<{ off: boolean; has: boolean }>(
    "select nudges_opt_out as off, exists (select 1 from renewal_items i where i.owner_user_id = u.id) as has from users u where u.id = $1",
    [user.id],
  );
  const [bizName, bizAllowed, bizSettings] = await Promise.all([businessName(user.id), businessAllowed(user.id), getSetting("business")]);
  // Business tools are given by an admin; others see how to ask for them.
  const biz = { show: bizAllowed && (bizSettings.enabled || Boolean(bizName)), request: !bizAllowed && bizSettings.enabled, name: bizName };
  const nudge = { show: Boolean(nudgeRows[0] && !nudgeRows[0].has), on: !nudgeRows[0]?.off };
  return (
    <div className="stack">
      <h1>{t("settings.title")}</h1>
      {staffMust && <div className="alert warn" role="alert"><span><strong>{t("tfa.staffRequired")}</strong> <a href="#two-factor">{t("tfa.enable")} →</a></span></div>}
      <h2 className="set-h">{t("set.account")}</h2>
      <div className="card">
        <div className="field mb-0">
          <label htmlFor="phone">{t("settings.phone")}</label>
          <input id="phone" type="text" value={`+977 ${formatPhoneLocal(user.phoneE164)}`} readOnly />
          <span className="hint">{t("settings.phoneHint")} · Asia/Kathmandu</span>
        </div>
      </div>
      <SettingsForm displayName={user.displayName ?? ""} smsLanguage={user.locale} balance={(await readWallet(user.id)).posted} />
      <h2 className="set-h">{t("set.reminders")}</h2>
      <PushManager />
      {nudge.show && <NudgesToggle initial={nudge.on} />}
      {pro && <EmailManager initial={email} digest={proPrefs.digest} />}
      {calendar && <CalendarSync initial={calendar} />}
      <h2 className="set-h">{t("set.sharing")}</h2>
      {ref.settings.enabled && (
        <InviteFriends link={link} referrerCredits={ref.settings.referrer_credits} refereeCredits={ref.settings.referee_credits} minTopup={ref.settings.min_topup_npr}
          message={ref.settings.message} invited={ref.invited} rewarded={ref.rewarded} pending={ref.pending} creditsEarned={ref.creditsEarned} />
      )}
      {biz.show && <BusinessCard initial={biz.name} />}
      {biz.request && (
        <section className="card">
          <h2>{t("biz.title")}</h2>
          <p className="muted">{t("biz.request")}</p>
          <Link className="btn btn-secondary btn-sm" href="/support">{t("biz.requestCta")}</Link>
        </section>
      )}
      <h2 className="set-h">{t("set.security")}</h2>
      {staffMust && <TwoFactorManager initial={tfa} />}
      <PinManager initial={pin} />
      {!staffMust && <TwoFactorManager initial={tfa} />}
      <h2 className="set-h">{t("set.apps")}</h2>
      <InstallApp variant="card" />
      <ConnectedApps connections={connections} />
      <SessionsCard />
    </div>
  );
}
