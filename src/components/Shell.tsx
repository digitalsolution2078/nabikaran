"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon, type IconName } from "./Icon";
import { LiveClock } from "./LiveClock";
import { usePrefs } from "./Prefs";
import type { MessageKey } from "@/lib/i18n/dict";
import { localizeNumber } from "@/lib/i18n/format";

export interface ShellUser {
  name: string | null;
  phoneLocal: string;
  isAdmin: boolean;
  availableCredits: number;
}

const APP_PREFIXES = ["/dashboard", "/renewals", "/wallet", "/settings", "/admin", "/onboarding"];

const NAV: { href: string; icon: IconName; key: MessageKey }[] = [
  { href: "/dashboard", icon: "home", key: "nav.dashboard" },
  { href: "/renewals", icon: "bell", key: "nav.reminders" },
  { href: "/wallet", icon: "wallet", key: "nav.wallet" },
  { href: "/settings", icon: "settings", key: "nav.settings" },
];

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="logo" aria-label="Nabikaran home">
      <span className="logo-mark" aria-hidden>न</span>
      <span>Nabikaran<small>नवीकरण</small></span>
    </Link>
  );
}

function isActive(path: string, href: string) {
  return path === href || path.startsWith(`${href}/`);
}

export function Shell({ user, clockIso, children }: { user: ShellUser | null; clockIso: string; children: React.ReactNode }) {
  const path = usePathname() ?? "/";
  const inApp = Boolean(user) && APP_PREFIXES.some((p) => isActive(path, p));
  return inApp && user ? <AppShell user={user} path={path} clockIso={clockIso}>{children}</AppShell> : <PublicShell signedIn={Boolean(user)}>{children}</PublicShell>;
}

function AppShell({ user, path, clockIso, children }: { user: ShellUser; path: string; clockIso: string; children: React.ReactNode }) {
  const { t, prefs, setPrefs } = usePrefs();
  const router = useRouter();
  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };
  return (
    <div className="app">
      <aside className="sidebar" aria-label="Main navigation">
        <Logo href="/dashboard" />
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={`side-link ${isActive(path, n.href) && !path.startsWith("/renewals/new") ? "active" : ""}`} aria-current={isActive(path, n.href) ? "page" : undefined}>
            <Icon name={n.icon} /> {t(n.key)}
          </Link>
        ))}
        <Link href="/renewals/new" className="btn btn-primary" style={{ margin: "10px 4px" }}><Icon name="plus" /> {t("dash.addReminder")}</Link>
        {user.isAdmin && (
          <>
            <div className="side-section">Admin</div>
            <Link href="/admin" className={`side-link ${isActive(path, "/admin") ? "active" : ""}`}><Icon name="shield" /> {t("nav.admin")}</Link>
          </>
        )}
        <div className="spacer" />
        <div className="side-card">
          <div className="muted small">{t("dash.available")}</div>
          <div style={{ fontFamily: "var(--font-head)", fontSize: 22, fontWeight: 700 }}>{localizeNumber(user.availableCredits, prefs.lang)}</div>
          <Link href="/wallet" className="small">{t("dash.topUp")} →</Link>
        </div>
        <button className="side-link" style={{ border: 0, background: "transparent", cursor: "pointer", font: "inherit" }} onClick={logout}><Icon name="logout" /> {t("nav.logout")}</button>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="inner">
            <span className="mobile-logo"><Logo href="/dashboard" /></span>
            <LiveClock initialIso={clockIso} />
            <div className="right">
              <button className="btn btn-ghost btn-sm" onClick={() => setPrefs({ ...prefs, lang: prefs.lang === "ne" ? "en" : "ne" })} aria-label="Switch language">
                <Icon name="globe" size={16} /> {prefs.lang === "ne" ? "EN" : "ने"}
              </button>
              <Link href="/settings" className="btn btn-secondary btn-sm hide-mobile">{user.name ?? user.phoneLocal}</Link>
            </div>
          </div>
        </header>
        <main className="content" id="main">{children}</main>
      </div>
      <nav className="bottom-nav" aria-label="Main navigation">
        <Link href="/dashboard" className={isActive(path, "/dashboard") ? "active" : ""}><Icon name="home" /><span>{t("nav.dashboard")}</span></Link>
        <Link href="/renewals" className={isActive(path, "/renewals") && !path.startsWith("/renewals/new") ? "active" : ""}><Icon name="bell" /><span>{t("nav.reminders")}</span></Link>
        <Link href="/renewals/new" className="fab" aria-label={t("dash.addReminder")}><span className="icon-wrap"><Icon name="plus" /></span><span>{t("nav.add")}</span></Link>
        <Link href="/wallet" className={isActive(path, "/wallet") ? "active" : ""}><Icon name="wallet" /><span>{t("nav.wallet")}</span></Link>
        {user.isAdmin ? (
          <Link href="/admin" className={isActive(path, "/admin") ? "active" : ""}><Icon name="shield" /><span>{t("nav.admin")}</span></Link>
        ) : (
          <Link href="/settings" className={isActive(path, "/settings") ? "active" : ""}><Icon name="settings" /><span>{t("nav.settings")}</span></Link>
        )}
      </nav>
    </div>
  );
}

function PublicShell({ signedIn, children }: { signedIn: boolean; children: React.ReactNode }) {
  const { t, prefs, setPrefs } = usePrefs();
  return (
    <>
      <header className="pub-header">
        <div className="inner">
          <Logo />
          <nav>
            <button className="btn btn-ghost btn-sm" onClick={() => setPrefs({ ...prefs, lang: prefs.lang === "ne" ? "en" : "ne" })} aria-label="Switch language">
              <Icon name="globe" size={16} /> {prefs.lang === "ne" ? "English" : "नेपाली"}
            </button>
            {signedIn ? (
              <Link href="/dashboard" className="btn btn-primary btn-sm">{t("nav.dashboard")}</Link>
            ) : (
              <>
                <Link href="/login" className="btn btn-secondary btn-sm hide-mobile">{t("nav.signin")}</Link>
                <Link href="/login" className="btn btn-primary btn-sm">{t("nav.getStarted")}</Link>
              </>
            )}
          </nav>
        </div>
      </header>
      <main className="pub-main" id="main">{children}</main>
      <footer className="pub-footer">
        <div className="inner">
          <span>© {new Date().getFullYear()} Nabikaran · nabikaran.org</span>
          <span className="row">
            <Link href="/privacy">{t("common.privacy")}</Link>
            <Link href="/terms">{t("common.terms")}</Link>
            <Link href="/docs/mcp">{t("common.aiDocs")}</Link>
          </span>
        </div>
      </footer>
    </>
  );
}
