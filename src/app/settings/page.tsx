import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { SettingsForm } from "@/components/SettingsForm";
import { formatPhoneLocal } from "@/lib/phone";
import { ConnectedApps } from "@/components/ConnectedApps";
import { listConnections } from "@/lib/oauth/tokens";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const connections = await listConnections(user.id);
  return (
    <div>
      <h1>Settings</h1>
      <div className="card">
        <label>Verified mobile (read-only)</label>
        <input value={formatPhoneLocal(user.phoneE164)} readOnly />
        <p className="muted" style={{ fontSize: 13 }}>Changing your number requires secure re-verification (SIM change). Time zone: Asia/Kathmandu.</p>
      </div>
      <SettingsForm displayName={user.displayName ?? ""} locale={user.locale} />
      <ConnectedApps connections={connections} />
    </div>
  );
}
