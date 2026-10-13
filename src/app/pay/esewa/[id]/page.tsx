import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { getRequestContext } from "@/lib/i18n/server";
import { getDb } from "@/lib/db";
import { getPaymentGateway } from "@/lib/payments";
import { EsewaGateway } from "@/lib/payments/esewa";
import { localizeNumber } from "@/lib/i18n/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "eSewa payment", robots: { index: false, follow: false } };

/**
 * eSewa ePay v2 checkout is a signed form POST. This page signs the order on
 * the server and submits the form to eSewa (a button is shown if scripts are off).
 */
export default async function EsewaCheckout({ params }: { params: Promise<{ id: string }> }) {
  const { user, t, prefs } = await getRequestContext();
  const { id } = await params;
  if (!user) redirect("/login?next=/wallet");
  if (!z.string().uuid().safeParse(id).success) notFound();
  const { rows } = await getDb().query<{ order_reference: string; amount_paisa: string; status: string }>(
    "select order_reference, amount_paisa::text, status from payment_orders where id = $1 and user_id = $2 and gateway = 'esewa'",
    [id, user.id],
  );
  const o = rows[0];
  if (!o) notFound();
  if (o.status === "paid") redirect("/wallet?payment=success");
  if (!["initiated", "pending"].includes(o.status)) redirect("/wallet?payment=pending:" + o.status);
  const gw = getPaymentGateway("esewa") as EsewaGateway;
  const fields = gw.formFields({ orderReference: o.order_reference, amountPaisa: Number(o.amount_paisa) });
  return (
    <div className="card" style={{ maxWidth: 480, margin: "40px auto", textAlign: "center" }}>
      <h1>eSewa</h1>
      <p className="muted">{t("common.npr")} {localizeNumber(Number(o.amount_paisa) / 100, prefs.lang)} · <span className="mono">{o.order_reference}</span></p>
      <form id="esewa" method="POST" action={gw.formUrl}>
        {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <button className="btn btn-primary btn-lg btn-block" type="submit">{t("wallet.payEsewa")}</button>
      </form>
      <p className="hint mt mb-0">{t("wallet.esewaRedirect")}</p>
      <script dangerouslySetInnerHTML={{ __html: "setTimeout(function(){var f=document.getElementById('esewa');if(f)f.submit();},400);" }} />
    </div>
  );
}
