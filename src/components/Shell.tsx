"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon, type IconName } from "./Icon";
import { LiveClock } from "./LiveClock";
import { usePrefs } from "./Prefs";
import type { MessageKey } from "@/lib/i18n/dict";
import { formatDate, localizeNumber } from "@/lib/i18n/format";

export interface ShellUser {
  name: string | null;
  phoneLocal: string;
  isAdmin: boolean;
  availableCredits: number;
  /** Pro (trial, paid or granted) is active. */
  pro?: boolean;
  /** Pro is on sale (shows the single "Pro" entry point to Basic accounts). */
  proOffer?: boolean;
  /** Pro membership details for the sidebar card. */
  plan?: { kind: string | null; endsAt: string | null; left: Record<"sms" | "whatsapp" | "email", number> | null } | null;
}

const APP_PREFIXES = ["/dashboard", "/renewals", "/messages", "/wallet", "/settings", "/admin", "/onboarding", "/pro", "/subscriptions", "/insights", "/history"];

const PRO_NAV: { href: string; icon: IconName; key: MessageKey }[] = [
  { href: "/subscriptions", icon: "repeat", key: "nav.subscriptions" },
  { href: "/insights", icon: "chart", key: "nav.insights" },
  { href: "/history", icon: "clock", key: "nav.history" },
];

/** Small "PRO" mark used in the sidebar, header and Pro pages. */
export function ProBadge({ small = false }: { small?: boolean }) {
  return <span className={`pro-badge${small ? " sm" : ""}`}>PRO</span>;
}

const NAV: { href: string; icon: IconName; key: MessageKey }[] = [
  { href: "/dashboard", icon: "home", key: "nav.dashboard" },
  { href: "/renewals", icon: "bell", key: "nav.reminders" },
  { href: "/messages", icon: "message", key: "nav.messages" },
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
    <div className={`app${user.pro ? " is-pro" : ""}`}>
      <aside className="sidebar" aria-label="Main navigation">
        <Logo href="/dashboard" />
        {[...NAV.slice(0, 2), ...(user.pro ? PRO_NAV : []), ...NAV.slice(2), ...(user.pro || user.proOffer ? [{ href: "/pro", icon: "star" as IconName, key: "nav.pro" as MessageKey }] : [])].map((n) => (
          <Link key={n.href} href={n.href} className={`side-link ${isActive(path, n.href) && !path.startsWith("/renewals/new") ? "active" : ""}`} aria-current={isActive(path, n.href) ? "page" : undefined}>
            <Icon name={n.icon} /> {t(n.key)}
          </Link>
        ))}
        <Link href="/renewals/new" className="btn btn-primary" style={{ margin: "10px 4px 0" }}><Icon name="plus" /> {t("dash.addReminder")}</Link>
        {user.pro && <Link href="/subscriptions#add" className="btn btn-secondary btn-sm" style={{ margin: "6px 4px 10px" }}><Icon name="repeat" size={14} /> {t("sub.addSub")}</Link>}
        {!user.pro && <span style={{ height: 10 }} />}
        {user.isAdmin && (
          <>
            <div className="side-section">Admin</div>
            <Link href="/admin" className={`side-link ${isActive(path, "/admin") ? "active" : ""}`}><Icon name="shield" /> {t("nav.admin")}</Link>
          </>
        )}
        <div className="spacer" />
        <div className={`side-card${user.pro ? " pro-card" : ""}`}>
          <Link href={user.pro || user.proOffer ? "/pro" : "/wallet"} className="plan-line">
            {user.pro ? <ProBadge /> : <span className="basic-label">{t("plan.basic")}</span>}
            {user.pro && user.plan?.endsAt && <span className="small muted">{t("plan.until", { date: formatDate(user.plan.endsAt, prefs, { short: true }) })}</span>}
          </Link>
          {user.plan?.left && (
            <div className="small allow-line" title={t("plan.includedLeft")}>
              <span>SMS {localizeNumber(user.plan.left.sms, prefs.lang)}</span> · <span>WA {localizeNumber(user.plan.left.whatsapp, prefs.lang)}</span> · <span>Email {localizeNumber(user.plan.left.email, prefs.lang)}</span>
            </div>
          )}
          <div className="muted small mt-xs">{user.pro ? t("plan.credits") : t("dash.available")}</div>
          <div style={{ fontFamily: "var(--font-head)", fontSize: 22, fontWeight: 700 }}>{localizeNumber(user.availableCredits, prefs.lang)}</div>
          <Link href="/wallet" className="small">{t("dash.topUp")} →</Link>
        </div>
        <button className="side-link" style={{ border: 0, background: "transparent", cursor: "pointer", font: "inherit" }} onClick={logout}><Icon name="logout" /> {t("nav.logout")}</button>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="inner">
            <span className="mobile-logo"><Logo href="/dashboard" />{user.pro && <Link href="/pro" aria-label="Nabikaran Pro"><ProBadge small /></Link>}</span>
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
