import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { OtpForm } from "@/components/OtpForm";
import { Icon } from "@/components/Icon";
import { getSetting } from "@/lib/services/settings";
import { cookies } from "next/headers";
import { REFERRAL_COOKIE, normalizeCode, referrerByCode } from "@/lib/services/referrals";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; ref?: string }> }) {
  const { next, ref } = await searchParams;
  const safeNext = next && /^\/(?!\/)/.test(next) ? next : null;
  const { user, t } = await getRequestContext();
  if (user) redirect(safeNext ?? "/dashboard");
  const [signin, pinCfg, refCfg, jar] = await Promise.all([getSetting("signin"), getSetting("pin"), getSetting("referral"), cookies()]);
  const refCode = normalizeCode(ref ?? jar.get(REFERRAL_COOKIE)?.value);
  const inviter = refCode && refCfg.enabled ? await referrerByCode(refCode).catch(() => null) : null;
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="card" style={{ padding: 26 }}>
          <div className="avatar-icon" style={{ marginBottom: 12 }}><Icon name="lock" /></div>
          <h1>{t("login.title")}</h1>
          <p className="muted">{t("login.subtitle")}</p>
          {inviter && (
            <div className="alert ok"><span>{t("ref.banner", { name: inviter.name?.split(" ")[0] ?? t("ref.aFriend"), bonus: String(refCfg.referee_credits), min: String(refCfg.min_topup_npr) })}</span></div>
          )}
          <OtpForm next={safeNext} fee={signin.fee_credits} pinEnabled={pinCfg.enabled} refCode={inviter ? refCode : null} />
        </div>
        <p className="small muted mt" style={{ textAlign: "center" }}>{t("landing.a3")}</p>
      </div>
    </div>
  );
}
