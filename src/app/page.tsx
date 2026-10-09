import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";

export default async function Home() {
  const user = await getCurrentUser();
  return (
    <div>
      <h1>म्याद सकिनु अघि SMS — Never miss a renewal</h1>
      <p>Save the expiry date of your Bluebook, driving licence, passport, insurance, warranty or subscription. Nabikaran sends an SMS reminder to your verified Nepal mobile exactly when you choose.</p>
      <div className="card">
        <ul>
          <li>Gregorian or Bikram Sambat dates — you pick, we convert.</li>
          <li>Prepaid wallet: 1 credit = NPR 1. Purchased credits never expire while your account is active.</li>
          <li>You see the exact SMS text and cost before confirming. You are charged only when the SMS is accepted by the provider.</li>
          <li>Pay with Khalti (eSewa coming next).</li>
        </ul>
        <Link className="btn" href={user ? "/dashboard" : "/login"}>{user ? "Go to dashboard" : "Start with your mobile number"}</Link>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>Nabikaran is a reminder service only: it does not renew documents, access official records, or guarantee handset delivery.</p>
    </div>
  );
}
