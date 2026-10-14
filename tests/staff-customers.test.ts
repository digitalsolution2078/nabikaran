import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, wallet } from "./helpers/db";
import type { Db } from "@/lib/db";
import { MockSmsProvider } from "@/lib/providers/sms/mock";
import { setSmsProviderForTests } from "@/lib/providers/sms";
import { createCustomerByStaff, recentStaffCustomers, staffCustomerSchema } from "@/lib/services/staff-customers";
import { approveWalletAdjustment } from "@/lib/services/admin";
import { counterLookup } from "@/lib/services/counter";

let db: Db;
let close: () => Promise<void> = async () => undefined;
const sms = new MockSmsProvider();
const staff: Record<string, { id: string; role: string }> = {};
let n = 0;
const input = (o: Record<string, unknown>) => staffCustomerSchema.parse({ idempotencyKey: `k-staff-customer-${++n}`, ...o });
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? String(e));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  setSmsProviderForTests(sms);
  for (const [i, role] of (["super_admin", "admin", "support", "counter", "auditor"] as const).entries()) {
    const id = await createUser(db, `+97798410090${i}0`, "admin");
    await db.query("update users set role = $2 where id = $1", [id, role]);
    staff[role] = { id, role };
  }
});
afterAll(async () => {
  setSmsProviderForTests(undefined);
  await close();
});

describe("staff add customers", () => {
  it("creates an account the customer can later sign in to, with a welcome SMS", async () => {
    const r = await createCustomerByStaff(staff.counter, input({ phone: "985-1009001", name: "  Ram   Thapa ", welcomeSms: true }), db);
    expect(r).toMatchObject({ customer: { phone: "+9779851009001", name: "Ram Thapa", available: 0 }, credit: { kind: "none" }, welcomeSms: "sent" });
    const text = sms.sent.find((m) => m.to === "+9779851009001")!.text;
    expect(text).toContain("nabikaran.org");
    expect(text.length).toBeLessThanOrEqual(160);
    expect((await counterLookup("9851009001", db)).id).toBe(r.customer.id);
    const { rows } = await db.query<{ created_by: string; phone_verified_at: unknown }>("select created_by, phone_verified_at from users where id = $1", [r.customer.id]);
    expect(rows[0]).toMatchObject({ created_by: staff.counter.id, phone_verified_at: null });
    expect((await recentStaffCustomers(5, db))[0]).toMatchObject({ id: r.customer.id, signedIn: false });
  });

  it("refuses an existing number (pointing to it), a bad number and a taken email", async () => {
    const e = await createCustomerByStaff(staff.admin, input({ phone: "9851009001" }), db).catch((x) => x);
    expect(e.code).toBe("customer_exists");
    expect(e.detail.id).toBeTruthy();
    expect(await code(createCustomerByStaff(staff.admin, input({ phone: "123456789" }), db))).toBe("invalid_phone");
    await createCustomerByStaff(staff.admin, input({ phone: "9851009002", email: "Sita@Example.com" }), db);
    expect(await code(createCustomerByStaff(staff.admin, input({ phone: "9851009003", email: "sita@example.com" }), db))).toBe("email_taken");
  });

  it("paid credit is a counter top-up; free credit is applied by a super admin and needs approval otherwise", async () => {
    const paid = await createCustomerByStaff(staff.counter, input({ phone: "9851009004", credit: { kind: "paid", amountNpr: 300, method: "cash", receipt: "B-101" } }), db);
    expect(paid.credit).toMatchObject({ kind: "paid", credits: 300 });
    expect(paid.customer.available).toBe(300);
    const { rows } = await db.query<{ source: string; payment_method: string }>("select source, payment_method from manual_topup_requests where user_id = $1", [paid.customer.id]);
    expect(rows[0]).toMatchObject({ source: "counter", payment_method: "cash" });

    const gift = await createCustomerByStaff(staff.super_admin, input({ phone: "9851009005", credit: { kind: "free", credits: 50, reason: "launch offer" } }), db);
    expect(gift.credit).toMatchObject({ kind: "free", status: "applied", credits: 50 });
    expect((await wallet(db, gift.customer.id)).available).toBe(50);

    const asked = await createCustomerByStaff(staff.support, input({ phone: "9851009006", credit: { kind: "free", credits: 20, reason: "partner" } }), db);
    expect(asked.credit).toMatchObject({ kind: "free", status: "pending" });
    expect((await wallet(db, asked.customer.id)).available).toBe(0);
    const { rows: req } = await db.query<{ id: string }>("select id from wallet_adjustment_requests where user_id = $1", [asked.customer.id]);
    await approveWalletAdjustment(staff.admin.id, req[0].id, db);
    expect((await wallet(db, asked.customer.id)).available).toBe(20);
  });

  it("roles decide what is allowed", async () => {
    expect(await code(createCustomerByStaff(staff.auditor, input({ phone: "9851009007" }), db))).toBe("forbidden");
    expect(await code(createCustomerByStaff(staff.support, input({ phone: "9851009007", credit: { kind: "paid", amountNpr: 100, method: "cash" } }), db))).toBe("forbidden");
    expect(await code(createCustomerByStaff(staff.counter, input({ phone: "9851009007", credit: { kind: "free", credits: 10, reason: "test" } }), db))).toBe("forbidden");
    // Refused before anything was written.
    expect(await code(counterLookup("9851009007", db))).toBe("customer_not_found");
  });

  it("eSewa is gone as a counter method", () => {
    expect(staffCustomerSchema.safeParse({ phone: "9851009008", idempotencyKey: "k-esewa-gone", credit: { kind: "paid", amountNpr: 100, method: "esewa" } }).success).toBe(false);
  });
});
