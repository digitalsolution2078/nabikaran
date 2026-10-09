import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { OtpForm } from "@/components/OtpForm";
import { Icon } from "@/components/Icon";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const safeNext = next && /^\/(?!\/)/.test(next) ? next : null;
  const { user, t } = await getRequestContext();
  if (user) redirect(safeNext ?? "/dashboard");
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="card" style={{ padding: 26 }}>
          <div className="avatar-icon" style={{ marginBottom: 12 }}><Icon name="lock" /></div>
          <h1>{t("login.title")}</h1>
          <p className="muted">{t("login.subtitle")}</p>
          <OtpForm next={safeNext} />
        </div>
        <p className="small muted mt" style={{ textAlign: "center" }}>{t("landing.a3")}</p>
      </div>
    </div>
  );
}
