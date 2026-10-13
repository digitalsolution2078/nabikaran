import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, wallet } from "./helpers/db";
import type { Db } from "@/lib/db";
import { MockGateway } from "@/lib/payments/mock";
import { EsewaGateway, esewaSign, mapEsewaStatus } from "@/lib/payments/esewa";
import { addPaymentGatewayForTests, enabledGateways, setPaymentGatewayForTests } from "@/lib/payments";
import { confirmPaymentByRef, createCustomTopupOrder } from "@/lib/services/payments";

let db: Db;
let close: () => Promise<void> = async () => undefined;
const status: Record<string, { status: string; total: string; ref_id?: string }> = {};
const calls: string[] = [];
const fakeFetch = (async (url: string) => {
  calls.push(url);
  const u = new URL(url);
  const s = status[u.searchParams.get("transaction_uuid") ?? ""];
  const body = s ? { product_code: "EPAYTEST", transaction_uuid: u.searchParams.get("transaction_uuid"), total_amount: Number(s.total), status: s.status, ref_id: s.ref_id ?? null } : { code: 0, error_message: "not found", status: "NOT_FOUND" };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;
const esewa = new EsewaGateway({ productCode: "EPAYTEST", secretKey: "8gBm/:&EnhH.1/q", formUrl: "https://rc-epay.esewa.com.np/api/epay/main/v2/form", statusUrl: "https://rc.esewa.com.np/api/epay/transaction/status/", appUrl: "https://nabikaran.test", fetchImpl: fakeFetch });

beforeAll(async () => {
  ({ db, close } = await createTestDb({ topupBonus: true }));
  setPaymentGatewayForTests(new MockGateway("https://nabikaran.test"));
  addPaymentGatewayForTests(esewa);
});
afterAll(async () => {
  setPaymentGatewayForTests(undefined);
  await close();
});

describe("eSewa ePay v2", () => {
  it("signs total_amount,transaction_uuid,product_code with HMAC-SHA256 (base64)", () => {
    // Reference value computed independently (Python hmac/sha256).
    expect(esewaSign("8gBm/:&EnhH.1/q", "total_amount=100,transaction_uuid=11-201-13,product_code=EPAYTEST")).toBe("5DZywcrTKD0gia/rsSMcrRHmJl+4Tbol6S+lWgdJ94E=");
    const f = esewa.formFields({ orderReference: "NB-ABC-123", amountPaisa: 50000 });
    expect(f).toMatchObject({ amount: "500", total_amount: "500", tax_amount: "0", transaction_uuid: "NB-ABC-123", product_code: "EPAYTEST", signed_field_names: "total_amount,transaction_uuid,product_code" });
    expect(f.signature).toBe(esewaSign("8gBm/:&EnhH.1/q", "total_amount=500,transaction_uuid=NB-ABC-123,product_code=EPAYTEST"));
    expect(f.success_url).toBe("https://nabikaran.test/api/payments/esewa/return");
    expect(f.failure_url).toContain("ref=NB-ABC-123");
  });

  it("reads the order from the success redirect and rejects junk", () => {
    const data = Buffer.from(JSON.stringify({ transaction_code: "000AWEO", status: "COMPLETE", total_amount: 500, transaction_uuid: "NB-ABC-123" })).toString("base64");
    expect(EsewaGateway.refFromReturnData(data)).toBe("NB-ABC-123");
    expect(EsewaGateway.refFromReturnData("not-base64-json")).toBeNull();
    expect(EsewaGateway.refFromReturnData(Buffer.from(JSON.stringify({ transaction_uuid: "x'; drop" })).toString("base64"))).toBeNull();
    expect(mapEsewaStatus("COMPLETE")).toBe("completed");
    expect(mapEsewaStatus("FULL_REFUND")).toBe("refunded");
    expect(mapEsewaStatus("CANCELED")).toBe("canceled");
  });

  it("is offered next to the other gateway", () => {
    expect(enabledGateways().sort()).toEqual(["esewa", "mock"]);
  });

  it("credits automatically (with bonus) only after the status API says COMPLETE with the right amount, once", async () => {
    const uid = await createUser(db, "+9779841003001");
    const order = await createCustomTopupOrder({ id: uid, phoneE164: "+9779841003001" }, 1000, db, "esewa");
    expect(order.paymentUrl).toBe(`https://nabikaran.test/pay/esewa/${order.orderId}`);
    expect(order.gatewayRef).toBe(order.orderReference);

    status[order.orderReference] = { status: "PENDING", total: "1000" };
    expect(await confirmPaymentByRef("esewa", order.gatewayRef, db)).toMatchObject({ result: "not_completed", status: "pending" });
    expect(calls.at(-1)).toContain("total_amount=1000");

    status[order.orderReference] = { status: "COMPLETE", total: "1", ref_id: "ESEWA-REF-1" };
    expect(await confirmPaymentByRef("esewa", order.gatewayRef, db)).toMatchObject({ result: "mismatch", reason: "amount" });

    status[order.orderReference] = { status: "COMPLETE", total: "1000.0", ref_id: "ESEWA-REF-1" };
    expect(await confirmPaymentByRef("esewa", order.gatewayRef, db)).toMatchObject({ result: "credited", credits: 1050 });
    expect(await confirmPaymentByRef("esewa", order.gatewayRef, db)).toMatchObject({ result: "already_credited" });
    expect((await wallet(db, uid)).available).toBe(1050);
    const { rows } = await db.query<{ t: string }>("select type || ':' || signed_credits::text as t from wallet_ledger where user_id = $1 order by id", [uid]);
    expect(rows.map((r) => r.t)).toEqual(["topup:1000.00", "bonus:50.00"]);
  });

  it("a cancelled checkout never credits", async () => {
    const uid = await createUser(db, "+9779841003002");
    const order = await createCustomTopupOrder({ id: uid, phoneE164: "+9779841003002" }, 200, db, "esewa");
    status[order.orderReference] = { status: "CANCELED", total: "200" };
    expect(await confirmPaymentByRef("esewa", order.gatewayRef, db)).toMatchObject({ result: "not_completed", status: "canceled" });
    const { rows } = await db.query<{ status: string }>("select status from payment_orders where id = $1", [order.orderId]);
    expect(rows[0].status).toBe("cancelled");
    expect((await wallet(db, uid)).available).toBe(0);
  });
});
