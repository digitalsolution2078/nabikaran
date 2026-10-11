import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { counterLog } from "@/lib/services/counter";
import { getSetting } from "@/lib/services/settings";
import { CounterDesk } from "@/components/admin/CounterDesk";

export const dynamic = "force-dynamic";
export const metadata = { title: "Counter", robots: { index: false } };

/** Front desk: credit a customer's wallet for cash, or sell a gift card. Staff with counter.topup only. */
export default async function CounterPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/counter");
  if (!can(user.role, "counter.topup")) redirect("/dashboard");
  const [log, codes] = await Promise.all([counterLog({ staffId: user.id }), getSetting("codes")]);
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Counter</h1>
          <p>Signed in as {user.displayName ?? user.phoneE164} · <span className="badge info">{user.role.replace("_", " ")}</span>
            {user.role !== "super_admin" && codes.counter_daily_limit_npr > 0 ? <> · daily limit NPR {codes.counter_daily_limit_npr.toLocaleString()}</> : null}</p>
        </div>
        {can(user.role, "admin.view") && <a href="/admin" className="btn btn-ghost btn-sm">← Admin</a>}
      </div>
      <CounterDesk initialLog={log} canSeeAll={can(user.role, "admin.view")} gift={{ enabled: codes.gifts_enabled, min: codes.gift_min_npr, max: codes.gift_max_npr }} />
    </div>
  );
}
