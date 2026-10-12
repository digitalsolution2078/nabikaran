import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser } from "./helpers/db";
import type { Db } from "@/lib/db";
import { safeNext } from "@/lib/safe-next";
import { clientIp, errorResponse } from "@/lib/http";
import { createCouponBatch, redeemCode } from "@/lib/services/credit-codes";
import { approveManualTopup, startManualTopup, submitManualTopup } from "@/lib/services/manual-topups";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let superAdmin: string;
let finance: string;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  superAdmin = await createUser(db, "+9779841000600", "admin");
  await db.query("update users set role = 'super_admin' where id = $1", [superAdmin]);
  finance = await createUser(db, "+9779841000601");
  await db.query("update users set role = 'finance' where id = $1", [finance]);
});
afterAll(async () => close());

describe("redirects after sign-in", () => {
  it("allows same-site paths only", () => {
    for (const ok of ["/dashboard", "/renewals/abc?x=1#y", "/oauth/authorize?client_id=a&redirect_uri=https%3A%2F%2Fchatgpt.com"]) expect(safeNext(ok)).toBe(ok);
    for (const bad of ["//evil.com", "/\\evil.com", "/%5Cevil.com", "/%2F%2Fevil.com", "https://evil.com", "/\tevil", "javascript:alert(1)", "", null, "/" + "a".repeat(600)]) expect(safeNext(bad)).toBeNull();
  });
});

describe("client IP for rate limits", () => {
  const req = (h: Record<string, string>) => new Request("https://x.test/", { headers: h });
  it("uses the entry added by our proxy, not one the client sent", () => {
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }))).toBe("1.2.3.4");
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4" }))).toBe("1.2.3.4");
    expect(clientIp(req({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
  });
});

describe("error responses", () => {
  it("never pass database errors to the client", async () => {
    const r = errorResponse(Object.assign(new Error('duplicate key value violates unique constraint "users_phone_key"'), { code: "23505" }));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("users_phone_key");
    const own = errorResponse(Object.assign(new Error("Incorrect code"), { code: "invalid_code" }));
    expect(own.status).toBe(400);
  });
});

describe("money safeguards", () => {
  it("staff cannot redeem codes; admins have a coupon cap", async () => {
    const { codes } = await createCouponBatch({ id: superAdmin, role: "super_admin" }, { name: "Big", kind: "single", credits: 5000, count: 3 }, db);
    await expect(redeemCode(finance, codes[0], db)).rejects.toMatchObject({ code: "code_staff" });
    await expect(redeemCode(superAdmin, codes[0], db)).rejects.toMatchObject({ code: "code_staff" });
    const customer = await createUser(db, "+9779841000602");
    expect(await redeemCode(customer, codes[0], db)).toMatchObject({ credits: 5000 });
    await expect(createCouponBatch({ id: finance, role: "admin" }, { name: "Too big", kind: "single", credits: 100, count: 101 }, db)).rejects.toMatchObject({ code: "coupon_cap" });
    await expect(createCouponBatch({ id: finance, role: "admin" }, { name: "Ok size", kind: "single", credits: 100, count: 100 }, db)).resolves.toBeTruthy();
  });

  it("one bank reference funds one top-up, however it is typed", async () => {
    const a = await createUser(db, "+9779841000603");
    const b = await createUser(db, "+9779841000604");
    const r1 = (await startManualTopup(a, 100, db)).request;
    const r2 = (await startManualTopup(b, 100, db)).request;
    await submitManualTopup(a, r1.id, { payerTxnRef: "TXN-1" }, db);
    await submitManualTopup(b, r2.id, { payerTxnRef: "TXN-2" }, db);
    expect(await approveManualTopup(superAdmin, r1.id, "FT 1234-56", null, db)).toEqual({ credited: true });
    await expect(approveManualTopup(superAdmin, r2.id, "ft123456", null, db)).rejects.toMatchObject({ code: "bank_ref_used" });
  });
});
