"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "../Icon";

/**
 * Admin navigation in two levels: five groups on top, and only the current
 * group's pages below. Pages the role cannot open are hidden (and a group with
 * none is hidden too). Counts flag work waiting (open tickets, top-ups).
 */
type Need = "all" | "super" | "coupons" | "counter" | "support" | "revenue";
interface Item { href: string; label: string; need: Need; badge?: "support" | "topups" }
interface Group { key: string; label: string; icon: IconName; items: Item[] }

const GROUPS: Group[] = [
  { key: "overview", label: "Overview", icon: "home", items: [
    { href: "/admin", label: "Dashboard", need: "all" },
    { href: "/admin/revenue", label: "Revenue", need: "revenue" },
  ] },
  { key: "customers", label: "Customers", icon: "users", items: [
    { href: "/admin/users", label: "Users", need: "all" },
    { href: "/admin/support", label: "Support", need: "support", badge: "support" },
    { href: "/admin/messages", label: "Messages", need: "all" },
  ] },
  { key: "money", label: "Money", icon: "wallet", items: [
    { href: "/admin/wallet/topups", label: "Top-ups", need: "all", badge: "topups" },
    { href: "/counter", label: "Counter", need: "counter" },
    { href: "/admin/coupons", label: "Coupons & gifts", need: "coupons" },
  ] },
  { key: "content", label: "Content", icon: "file", items: [
    { href: "/admin/templates", label: "Templates", need: "all" },
    { href: "/admin/seo", label: "SEO pages", need: "all" },
  ] },
  { key: "system", label: "System", icon: "settings", items: [
    { href: "/admin/sms", label: "Channels & pricing", need: "all" },
    { href: "/admin/integrations", label: "Integrations", need: "super" },
    { href: "/admin/pro", label: "Pro & email", need: "super" },
    { href: "/admin/mcp", label: "AI apps (MCP)", need: "all" },
    { href: "/admin/settings", label: "Settings & roles", need: "super" },
    { href: "/admin/audit", label: "Audit log", need: "all" },
  ] },
];

export interface AdminAccess { superAdmin: boolean; coupons?: boolean; counter?: boolean; support?: boolean; revenue?: boolean }

export function AdminTabs({ counts = { support: 0, topups: 0 }, ...access }: AdminAccess & { counts?: { support: number; topups: number } }) {
  const path = usePathname() ?? "";
  const allowed = (n: Need) => n === "all" || (n === "super" ? access.superAdmin : Boolean(access[n]));
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => allowed(i.need)) })).filter((g) => g.items.length > 0);
  // The most specific matching page is the current one.
  const matches = (href: string) => (href === "/admin" ? path === "/admin" : path === href || path.startsWith(`${href}/`));
  const current = groups.flatMap((g) => g.items.map((i) => ({ g, i }))).filter(({ i }) => matches(i.href)).sort((a, b) => b.i.href.length - a.i.href.length)[0];
  const activeGroup = current?.g ?? groups[0];
  const groupCount = (g: Group) => g.items.reduce((n, i) => n + (i.badge ? counts[i.badge] : 0), 0);

  return (
    <nav className="admin-nav" aria-label="Admin sections">
      <div className="admin-groups">
        {groups.map((g) => {
          const on = g.key === activeGroup?.key;
          const c = groupCount(g);
          return (
            <Link key={g.key} href={g.items[0].href} className={`admin-group ${on ? "active" : ""}`} aria-current={on ? "true" : undefined}>
              <Icon name={g.icon} size={16} /> <span>{g.label}</span>
              {c > 0 && <span className="admin-count" aria-label={`${c} waiting`}>{c}</span>}
            </Link>
          );
        })}
      </div>
      {activeGroup && activeGroup.items.length > 1 && (
        <div className="admin-subnav">
          {activeGroup.items.map((i) => {
            const on = current?.i.href === i.href;
            const c = i.badge ? counts[i.badge] : 0;
            return (
              <Link key={i.href} href={i.href} className={on ? "active" : ""} aria-current={on ? "page" : undefined}>
                {i.label}{c > 0 && <span className="admin-count">{c}</span>}
              </Link>
            );
          })}
        </div>
      )}
    </nav>
  );
}
