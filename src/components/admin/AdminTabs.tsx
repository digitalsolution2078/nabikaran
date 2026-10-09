"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS: [string, string, boolean][] = [
  ["/admin", "Overview", false],
  ["/admin/users", "Users", false],
  ["/admin/messages", "Messages", false],
  ["/admin/wallet/topups", "Top-ups", false],
  ["/admin/sms", "Channels & pricing", false],
  ["/admin/templates", "Templates", false],
  ["/admin/audit", "Audit log", false],
  ["/admin/settings", "Settings & roles", true],
];

export function AdminTabs({ superAdmin }: { superAdmin: boolean }) {
  const path = usePathname() ?? "";
  return (
    <nav className="admin-tabs" aria-label="Admin sections">
      {TABS.filter(([, , su]) => !su || superAdmin).map(([href, label]) => {
        const active = href === "/admin" ? path === "/admin" : path.startsWith(href);
        return <Link key={href} href={href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>{label}</Link>;
      })}
    </nav>
  );
}
