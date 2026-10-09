import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { formatPhoneLocal } from "@/lib/phone";

export default async function Onboarding() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return (
    <div>
      <h1>स्वागत छ — Welcome</h1>
      <div className="card">
        <p>Your verified number: <strong>{formatPhoneLocal(user.phoneE164)}</strong>. All reminders are sent here only.</p>
        <ol>
          <li>Add a renewal with its expiry date (AD or BS).</li>
          <li>Choose when to be reminded and preview the exact SMS and credit cost.</li>
          <li>Top up the wallet — credits never expire.</li>
        </ol>
        <div className="row">
          <Link className="btn" href="/renewals/new">Add first renewal</Link>
          <Link className="btn secondary" href="/wallet">Top up wallet</Link>
        </div>
      </div>
    </div>
  );
}
