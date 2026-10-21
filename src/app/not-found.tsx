import Link from "next/link";
import { getRequestContext } from "@/lib/i18n/server";
import { Icon } from "@/components/Icon";

/** Branded, bilingual 404. */
export default async function NotFound() {
  const { t, user } = await getRequestContext();
  return (
    <div className="card" style={{ maxWidth: 560, margin: "40px auto", textAlign: "center" }}>
      <div className="avatar-icon" style={{ width: 56, height: 56, margin: "0 auto 12px" }}><Icon name="search" size={26} /></div>
      <h1>{t("nf.title")}</h1>
      <p className="muted">{t("nf.body")}</p>
      <div className="row mt" style={{ justifyContent: "center" }}>
        <Link href={user ? "/dashboard" : "/"} className="btn btn-primary">{user ? t("err.home") : t("nf.home")}</Link>
        <Link href="/support" className="btn btn-secondary">{t("nav.support")}</Link>
      </div>
    </div>
  );
}
