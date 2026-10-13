import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, wallet } from "./helpers/db";
import type { Db } from "@/lib/db";
import { MockGateway } from "@/lib/payments/mock";
import { FonepayCheckoutGateway, fonepayDate, fonepayHmac, parseVerification } from "@/lib/payments/fonepay";
import { addPaymentGatewayForTests, enabledGateways, setPaymentGatewayForTests } from "@/lib/payments";
import { confirmPaymentByRef, createCustomTopupOrder, reconcilePendingOrders } from "@/lib/services/payments";
import { GET as paymentReturn } from "@/app/api/payments/[gateway]/return/route";

let db: Db;
let close: () => Promise<void> = async () => undefined;
const SECRET = "fonepay-test-secret";
/** Fonepay verification answers by UID: "ok" (paid, amount), "fail", or a network error. */
const answers: Record<string, { kind: "ok"; amount: string } | { kind: "fail" } | { kind: "down" }> = {};
const calls: URL[] = [];
const fakeFetch = (async (url: string) => {
  const u = new URL(url);
  calls.push(u);
  const a = answers[u.searchParams.get("UID") ?? ""];
  if (!a || a.kind === "down") throw new Error("connect ETIMEDOUT");
  const xml = a.kind === "ok"
    ? `<?xml version="1.0"?><response><amount>${a.amount}</amount><message>successful</message><response_code>successful</response_code><success>true</success><uniqueId>${u.searchParams.get("UID")}</uniqueId></response>`
    : `<response><message>failed</message><response_code>failed</response_code><success>false</success></response>`;
  return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
}) as unknown as typeof fetch;
const fonepay = new FonepayCheckoutGateway({
  merchantCode: "NBKTEST",
  secretKey: SECRET,
  checkoutUrl: "https://dev-clientapi.fonepay.com/api/merchantRequest",
  verifyUrl: "https://dev-clientapi.fonepay.com/api/merchantRequest/verificationMerchant",
  appUrl: "https://nabikaran.test",
  fetchImpl: fakeFetch,
});
const user = async (phone: string) => ({ id: await createUser(db, phone), phoneE164: phone });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  setPaymentGatewayForTests(new MockGateway("https://nabikaran.test"));
  addPaymentGatewayForTests(fonepay);
});
afterAll(async () => {
  setPaymentGatewayForTests(undefined);
  await close();
});

describe("Checkout by Fonepay", () => {
  it("builds a signed checkout URL (HMAC-SHA512 over PID,MD,PRN,AMT,CRN,DT,R1,R2,RU)", () => {
    const now = new Date("2026-10-13T20:00:00Z"); // 14 Oct in Nepal
    expect(fonepayDate(now)).toBe("10/14/2026");
    const u = new URL(fonepay.checkoutUrl({ orderReference: "NB-ABC-123", amountPaisa: 50000, description: "Nabikaran wallet 500 credits" }, now));
    expect(u.origin + u.pathname).toBe("https://dev-clientapi.fonepay.com/api/merchantRequest");
    const p = Object.fromEntries(u.searchParams);
    expect(p).toMatchObject({ PID: "NBKTEST", MD: "P", PRN: "NB-ABC-123", AMT: "500", CRN: "NPR", DT: "10/14/2026", R1: "Nabikaran wallet 500 credits", R2: "Nabikaran", RU: "https://nabikaran.test/api/payments/fonepay/return" });
    const expected = createHmac("sha512", SECRET).update("NBKTEST,P,NB-ABC-123,500,NPR,10/14/2026,Nabikaran wallet 500 credits,Nabikaran,https://nabikaran.test/api/payments/fonepay/return").digest("hex");
    expect(p.DV).toBe(expected);
  });

  it("reads Fonepay's verification XML and checks the return signature", () => {
    expect(parseVerification("<response><success>true</success><response_code>successful</response_code><amount>100.0</amount><uniqueId>77</uniqueId></response>")).toMatchObject({ success: true, amount: 100, uniqueId: "77" });
    expect(parseVerification("<response><success>false</success><response_code>failed</response_code></response>")).toMatchObject({ success: false });
    expect(parseVerification("<html>error</html>").success).toBeNull();
    const r = { PRN: "NB-1", PID: "NBKTEST", PS: "true", RC: "successful", UID: "123", BC: "NIBL", INI: "9841", P_AMT: "100.0", R_AMT: "0.0" };
    const DV = fonepayHmac(SECRET, Object.values(r));
    expect(fonepay.returnSignatureValid({ ...r, DV })).toBe(true);
    expect(fonepay.returnSignatureValid({ ...r, P_AMT: "1.0", DV })).toBe(false);
  });

  it("is offered as a payment method", () => {
    expect(enabledGateways().sort()).toEqual(["fonepay", "mock"]);
  });

  it("credits only after Fonepay verifies the UID for our PRN and amount, once", async () => {
    const u = await user("+9779841006001");
    const order = await createCustomTopupOrder(u, 100, db, "fonepay");
    expect(order.paymentUrl).toContain("https://dev-clientapi.fonepay.com/api/merchantRequest?PID=NBKTEST");
    expect(order.gatewayRef).toBe(order.orderReference);

    // No UID yet (customer still on Fonepay): nothing to verify.
    expect(await confirmPaymentByRef("fonepay", order.gatewayRef, db)).toMatchObject({ result: "not_completed", status: "pending" });
    expect((await wallet(db, u.id)).posted).toBe(0);

    // A failed payment is not credited.
    answers.UIDFAIL = { kind: "fail" };
    expect(await confirmPaymentByRef("fonepay", order.gatewayRef, db, "UIDFAIL")).toMatchObject({ result: "not_completed", status: "failed" });

    // A wrong amount is refused.
    const o2 = await createCustomTopupOrder(u, 100, db, "fonepay");
    answers.UIDLOW = { kind: "ok", amount: "10.0" };
    expect(await confirmPaymentByRef("fonepay", o2.gatewayRef, db, "UIDLOW")).toMatchObject({ result: "mismatch", reason: "amount" });

    const o3 = await createCustomTopupOrder(u, 100, db, "fonepay");
    answers.UIDOK = { kind: "ok", amount: "100.0" };
    expect(await confirmPaymentByRef("fonepay", o3.gatewayRef, db, "UIDOK")).toMatchObject({ result: "credited", credits: 100 });
    expect(await confirmPaymentByRef("fonepay", o3.gatewayRef, db, "UIDOK")).toMatchObject({ result: "already_credited" });
    expect((await wallet(db, u.id)).posted).toBe(100);
    const v = calls.at(-1)!;
    expect(Object.fromEntries(v.searchParams)).toMatchObject({ PRN: o3.gatewayRef, PID: "NBKTEST", AMT: "100", UID: "UIDOK", BID: "" });
    expect(v.searchParams.get("DV")).toBe(fonepayHmac(SECRET, ["NBKTEST", "100", o3.gatewayRef, "", "UIDOK"]));
  });

  it("the return URL verifies with Fonepay; if Fonepay is down, the reconciler finishes it later with the saved UID", async () => {
    const u = await user("+9779841006002");
    const order = await createCustomTopupOrder(u, 250, db, "fonepay");
    answers.UIDLATE = { kind: "down" };
    const q = new URLSearchParams({ PRN: order.gatewayRef, PID: "NBKTEST", PS: "true", RC: "successful", UID: "UIDLATE", BC: "NIBL", INI: "9841", P_AMT: "250.0", R_AMT: "0.0" });
    q.set("DV", fonepayHmac(SECRET, [...q.values()]));
    const res = await paymentReturn(new Request(`https://nabikaran.test/api/payments/fonepay/return?${q}`), { params: Promise.resolve({ gateway: "fonepay" }) });
    expect(res.headers.get("location")).toContain("payment=pending");
    expect((await wallet(db, u.id)).posted).toBe(0);

    answers.UIDLATE = { kind: "ok", amount: "250.0" };
    await db.query("update payment_orders set created_at = now() - interval '5 minutes' where id = $1", [order.orderId]);
    const r = await reconcilePendingOrders(db);
    expect(r.credited).toBeGreaterThanOrEqual(1);
    expect((await wallet(db, u.id)).posted).toBe(250);
  });

  it("a return without a valid PRN goes back to the wallet as invalid", async () => {
    const res = await paymentReturn(new Request("https://nabikaran.test/api/payments/fonepay/return?UID=1"), { params: Promise.resolve({ gateway: "fonepay" }) });
    expect(res.headers.get("location")).toContain("payment=invalid");
  });
});
