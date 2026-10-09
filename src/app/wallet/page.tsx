import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getWallet, getLedger } from "@/lib/services/wallet";
import { listPacks } from "@/lib/services/payments";
import { TopupPacks } from "@/components/TopupPacks";

export const dynamic = "force-dynamic";

export default async function WalletPage({ searchParams }: { searchParams: Promise<{ payment?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { payment } = await searchParams;
  const [wallet, packs, ledger] = await Promise.all([getWallet(user.id), listPacks(), getLedger(user.id, 5)]);
  return (
    <div>
      <h1>Wallet</h1>
      {payment === "success" && <p className="notice">Payment verified — credits added.</p>}
      {payment?.startsWith("pending") && <p className="notice">Payment not completed yet. If you paid, it will be reconciled automatically within a few minutes.</p>}
      {(payment === "mismatch" || payment === "error" || payment === "invalid") && <p className="notice">We could not verify this payment. No credits were issued. Contact support with your order reference if you were charged.</p>}
      <div className="grid">
        <div className="stat"><div className="n">{wallet.available}</div><div className="l">Available</div></div>
        <div className="stat"><div className="n">{wallet.reserved}</div><div className="l">Reserved</div></div>
        <div className="stat"><div className="n">{wallet.posted}</div><div className="l">Total balance</div></div>
      </div>
      <h2>Top up</h2>
      <TopupPacks packs={packs.map((p) => ({ code: p.code, amountPaisa: Number(p.amount_paisa), credits: Number(p.credits) }))} />
      <h2>Recent activity</h2>
      <table><tbody>
        {ledger.map((l) => (
          <tr key={l.id}><td>{new Date(l.createdAt).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu" })}</td><td>{l.type}</td><td style={{ textAlign: "right" }}>{l.signedCredits > 0 ? "+" : ""}{l.signedCredits}</td></tr>
        ))}
      </tbody></table>
      <p><Link href="/wallet/history">Full history →</Link></p>
    </div>
  );
}
