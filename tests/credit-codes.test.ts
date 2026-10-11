import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, wallet } from "./helpers/db";
import type { Db } from "@/lib/db";
import { can } from "@/lib/auth/rbac";
import { setSetting } from "@/lib/services/settings";
import { couponBatchCsv, createCouponBatch, displayCode, hashCode, listCouponBatches, listMyGiftCards, normalizeCode, redeemCode, setCouponBatchStatus } from "@/lib/services/credit-codes";
import { approveManualTopup, cancelManualTopup, rejectManualTopup, startManualTopup, submitManualTopup } from "@/lib/services/manual-topups";
import { counterLog, counterLookup, counterSellGift, counterTopup } from "@/lib/services/counter";
import { categorize } from "@/lib/services/wallet-report";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let admin: string;
let finance: string;
let counter: string;
const A = () => ({ id: admin });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  admin = await createUser(db, "+9779841000960", "admin");
  await db.query("update users set role = 'super_admin' where id = $1", [admin]);
  finance = await createUser(db, "+9779841000961");
  await db.query("update users set role = 'finance' where id = $1", [finance]);
  counter = await createUser(db, "+9779841000962");
  await db.query("update users set role = 'counter' where id = $1", [counter]);
});
afterAll(async () => close());

const ledgerTypes = async (uid: string) => (await db.query<{ type: string; signed_credits: string }>("select type, signed_credits::text from wallet_ledger where user_id = $1 order by id", [uid])).rows.map((r) => `${r.type}:${r.signed_credits}`);

describe("codes", () => {
  it("normalizes and formats", () => {
    expect(normalizeCode(" ab12-cd34 ")).toBe("AB12CD34");
    expect(hashCode("ab12-cd34")).toBe(hashCode("AB12CD34"));
    expect(displayCode("ABCDEFGHJKLM")).toBe("ABCD-EFGH-JKLM");
  });
});

describe("admin coupons", () => {
  it("single-use codes: one customer each, then used up", async () => {
    const { batch, codes } = await createCouponBatch(A(), { name: "Flyers", kind: "single", credits: 25, count: 3 }, db);
    expect(codes).toHaveLength(3);
    expect(codes[0]).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    const u1 = await createUser(db, "+9779841000963");
    const u2 = await createUser(db, "+9779841000964");
    expect(await redeemCode(u1, codes[0].toLowerCase(), db)).toMatchObject({ credits: 25, source: "admin" });
    expect((await wallet(db, u1)).posted).toBe(25);
    await expect(redeemCode(u1, codes[0], db)).rejects.toMatchObject({ code: "code_already_redeemed" });
    await expect(redeemCode(u2, codes[0], db)).rejects.toMatchObject({ code: "code_used" });
    await expect(redeemCode(u2, "ZZZZ-ZZZZ-ZZZZ", db)).rejects.toMatchObject({ code: "code_invalid" });
    expect(await ledgerTypes(u1)).toEqual(["coupon:25"]);
    const b = (await listCouponBatches(db)).find((x) => x.id === batch.id)!;
    expect(b).toMatchObject({ redeemed: 1, creditsIssued: 25 });
    const { csv } = await couponBatchCsv(A(), batch.id, db);
    expect(csv.split("\n").filter(Boolean)).toHaveLength(4);
    for (const c of codes) expect(csv).toContain(c);
    // Disabling stops unused codes.
    await setCouponBatchStatus(A(), batch.id, "disabled", db);
    await expect(redeemCode(u2, codes[1], db)).rejects.toMatchObject({ code: "code_invalid" });
  });

  it("shared promo code: once per customer, total limit, expiry", async () => {
    const { codes } = await createCouponBatch(A(), { name: "Dashain", kind: "shared", credits: 10, maxRedemptions: 2, code: "dashain-50" }, db);
    expect(codes).toEqual(["DASHAIN50"]);
    const [x, y, z] = [await createUser(db, "+9779841000965"), await createUser(db, "+9779841000966"), await createUser(db, "+9779841000967")];
    await redeemCode(x, "Dashain50", db);
    await expect(redeemCode(x, "DASHAIN50", db)).rejects.toMatchObject({ code: "code_already_redeemed" });
    await redeemCode(y, "DASHAIN50", db);
    await expect(redeemCode(z, "DASHAIN50", db)).rejects.toMatchObject({ code: "code_used" });
    await expect(createCouponBatch(A(), { name: "Again", kind: "shared", credits: 10, code: "DASHAIN50" }, db)).rejects.toMatchObject({ code: "code_exists" });
    const { codes: [old] } = await createCouponBatch(A(), { name: "Old", kind: "single", credits: 5, count: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }, db);
    await db.query("update credit_codes set expires_at = now() - interval '1 minute' where code_hash = $1", [hashCode(old)]);
    await expect(redeemCode(z, old, db)).rejects.toMatchObject({ code: "code_expired" });
  });
});

describe("gift cards are bought with money, never from wallet credits", () => {
  it("QR gift: pending until paid, then anyone can redeem; buyer's wallet untouched", async () => {
    const buyer = await createUser(db, "+9779841000970");
    const friend = await createUser(db, "+9779841000971");
    const { request } = await startManualTopup(buyer, 500, db, { toName: "Aama", message: "Happy Dashain" });
    expect(request.purpose).toBe("gift");
    let [g] = await listMyGiftCards(buyer, db);
    expect(g).toMatchObject({ status: "pending", code: null, credits: 500, toName: "Aama", requestId: request.id });
    // Not usable before payment.
    const { rows } = await db.query<{ code_enc: string }>("select code_enc from credit_codes where id = $1", [g.id]);
    const { decryptSecret } = await import("@/lib/services/secrets");
    const code = decryptSecret(rows[0].code_enc)!;
    await expect(redeemCode(friend, code, db)).rejects.toMatchObject({ code: "code_invalid" });
    await submitManualTopup(buyer, request.id, { payerTxnRef: "TXN-GIFT-1" }, db);
    expect(await approveManualTopup(finance, request.id, "BANK-GIFT-1", null, db)).toEqual({ credited: true });
    [g] = await listMyGiftCards(buyer, db);
    expect(g.status).toBe("active");
    expect(g.code).toBe(displayCode(code));
    expect((await wallet(db, buyer)).posted).toBe(0); // the payment bought a code, not credits
    expect(await redeemCode(friend, g.code!, db)).toMatchObject({ credits: 500, source: "gift", message: "Happy Dashain" });
    expect(await ledgerTypes(friend)).toEqual(["gift:500"]);
    expect((await listMyGiftCards(buyer, db))[0]).toMatchObject({ status: "used", code: null });
    expect(categorize("gift", "credit_code", null)).toBe("coupon");
  });

  it("cancelled or rejected payments cancel the gift code", async () => {
    const buyer = await createUser(db, "+9779841000972");
    const a = await startManualTopup(buyer, 100, db, {});
    await cancelManualTopup(buyer, a.request.id, db);
    const b = await startManualTopup(buyer, 100, db, {});
    await submitManualTopup(buyer, b.request.id, { payerTxnRef: "TXN-GIFT-2" }, db);
    await rejectManualTopup(finance, b.request.id, "No payment found", db);
    expect((await listMyGiftCards(buyer, db)).map((g) => g.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("respects gift limits", async () => {
    const buyer = await createUser(db, "+9779841000973");
    await expect(startManualTopup(buyer, 10, db, {})).rejects.toMatchObject({ code: "invalid_amount" });
    await setSetting(A(), "codes", { gifts_enabled: false, gift_min_npr: 50, gift_max_npr: 5000, counter_daily_limit_npr: 50000 }, db);
    await expect(startManualTopup(buyer, 100, db, {})).rejects.toMatchObject({ code: "gifts_disabled" });
    await setSetting(A(), "codes", { gifts_enabled: true, gift_min_npr: 50, gift_max_npr: 5000, counter_daily_limit_npr: 1000 }, db);
  });
});

describe("counter", () => {
  it("role counter can only do counter work", () => {
    expect(can("counter", "counter.topup")).toBe(true);
    expect(can("counter", "admin.view")).toBe(false);
    expect(can("finance", "counter.topup")).toBe(true);
    expect(can("support", "counter.topup")).toBe(false);
    expect(can("admin", "coupons.manage")).toBe(true);
    expect(can("finance", "coupons.manage")).toBe(false);
  });

  it("credits a customer's wallet as a top-up, idempotently, within the daily limit", async () => {
    const cust = await createUser(db, "+9779841000980");
    expect((await counterLookup("9841000980", db)).id).toBe(cust);
    await expect(counterLookup("9841999999", db)).rejects.toMatchObject({ code: "customer_not_found" });
    const r = await counterTopup({ id: counter }, { phone: "9841000980", amountNpr: 600, method: "cash", receipt: "B-101", idempotencyKey: "k-counter-1" }, db);
    expect(r).toMatchObject({ credits: 600 });
    expect(r.reference).toMatch(/^CT/);
    // Double click: same key → same entry, no second credit.
    const again = await counterTopup({ id: counter }, { phone: "9841000980", amountNpr: 600, method: "cash", receipt: "B-101", idempotencyKey: "k-counter-1" }, db);
    expect(again.id).toBe(r.id);
    expect((await wallet(db, cust)).posted).toBe(600);
    expect(await ledgerTypes(cust)).toEqual(["topup:600"]);
    // Same receipt number cannot be used twice.
    await expect(counterTopup({ id: counter }, { phone: "9841000980", amountNpr: 100, method: "cash", receipt: "B-101", idempotencyKey: "k-counter-2" }, db)).rejects.toMatchObject({ code: "receipt_used" });
    // Daily limit (1000 set above): 600 used, 500 more is refused.
    await expect(counterTopup({ id: counter }, { phone: "9841000980", amountNpr: 500, method: "esewa", idempotencyKey: "k-counter-3" }, db)).rejects.toMatchObject({ code: "daily_limit" });
    // Super admins have no limit; nobody can credit themselves.
    await counterTopup(A(), { phone: "9841000980", amountNpr: 5000, method: "bank", idempotencyKey: "k-counter-4" }, db);
    await expect(counterTopup({ id: counter }, { phone: "9841000962", amountNpr: 100, method: "cash", idempotencyKey: "k-counter-5" }, db)).rejects.toMatchObject({ code: "self_topup" });
    const log = await counterLog({ staffId: counter }, db);
    expect(log.entries).toHaveLength(1);
    expect(log.totals).toEqual([{ method: "cash", amountNpr: 600, count: 1 }]);
    expect((await counterLog({ staffId: null }, db)).totalNpr).toBe(5600);
  });

  it("sells a gift card for cash: the code works at once", async () => {
    const r = await counterSellGift({ id: finance }, { amountNpr: 200, method: "cash", toName: "Bua", idempotencyKey: "k-gift-1" }, db);
    expect(r.code).toMatch(/^[2-9A-Z]{4}-/);
    const friend = await createUser(db, "+9779841000981");
    expect(await redeemCode(friend, r.code, db)).toMatchObject({ credits: 200, source: "gift" });
    expect((await wallet(db, finance)).posted).toBe(0);
    await expect(counterSellGift({ id: finance }, { amountNpr: 200, method: "cash", idempotencyKey: "k-gift-1" }, db)).rejects.toMatchObject({ code: "duplicate_sale" });
    await expect(counterSellGift({ id: finance }, { amountNpr: 20, method: "cash", idempotencyKey: "k-gift-2" }, db)).rejects.toMatchObject({ code: "invalid_amount" });
  });
});
