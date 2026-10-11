"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

type Need = boolean | "coupons" | "counter";
const TABS: [string, string, Need][] = [
  ["/admin", "Overview", false],
  ["/admin/users", "Users", false],
  ["/admin/messages", "Messages", false],
  ["/admin/wallet/topups", "Top-ups", false],
  ["/counter", "Counter", "counter"],
  ["/admin/coupons", "Coupons & gifts", "coupons"],
  ["/admin/sms", "Channels & pricing", false],
  ["/admin/templates", "Templates", false],
  ["/admin/seo", "SEO pages", false],
  ["/admin/audit", "Audit log", false],
  ["/admin/integrations", "Integrations", true],
  ["/admin/pro", "Pro & email", true],
  ["/admin/settings", "Settings & roles", true],
];

export function AdminTabs({ superAdmin, coupons = false, counter = false }: { superAdmin: boolean; coupons?: boolean; counter?: boolean }) {
  const path = usePathname() ?? "";
  return (
    <nav className="admin-tabs" aria-label="Admin sections">
      {TABS.filter(([, , need]) => (need === "coupons" ? coupons : need === "counter" ? counter : !need || superAdmin)).map(([href, label]) => {
        const active = href === "/admin" ? path === "/admin" : path.startsWith(href);
        return <Link key={href} href={href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>{label}</Link>;
      })}
    </nav>
  );
}
