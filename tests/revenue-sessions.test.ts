import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund } from "./helpers/db";
import type { Db } from "@/lib/db";
import { can } from "@/lib/auth/rbac";
import { loadUser } from "@/lib/auth/session";
import { approveManualTopup, startManualTopup, submitManualTopup } from "@/lib/services/manual-topups";
import { counterTopup } from "@/lib/services/counter";
import { presetRange, revenueCsv, revenueReport, validRange } from "@/lib/services/revenue";

let db: Db;
let close: () => Promise<void> = async () => undefined;
beforeAll(async () => ({ db, close } = await createTestDb({ topupBonus: true })));
afterAll(async () => close());

const today = () => new Date(Date.now() + 345 * 60_000).toISOString().slice(0, 10);

describe("revenue dashboard", () => {
  it("is visible to finance, admins and auditors only", () => {
    for (const r of ["finance", "admin", "super_admin", "auditor"] as const) expect(can(r, "revenue.view")).toBe(true);
    for (const r of ["support", "counter", "content", "user"] as const) expect(can(r, "revenue.view")).toBe(false);
  });

  it("counts rupees received by method, bonus as promotion, and credits customers hold", async () => {
    const cust = await createUser(db, "+9779841006001");
    const finance = await createUser(db, "+9779841006002");
    const counter = await createUser(db, "+9779841006003");
    await db.query("update users set role = 'finance' where id = $1", [finance]);
    await db.query("update users set role = 'counter' where id = $1", [counter]);
    const { request } = await startManualTopup(cust, 1000, db);
    await submitManualTopup(cust, request.id, { payerTxnRef: "REV-TXN-1" }, db);
    await approveManualTopup(finance, request.id, "REV-BANK-1", null, db);
    await counterTopup({ id: counter }, { phone: "9841006001", amountNpr: 200, method: "cash", idempotencyKey: "rev-ctr-1" }, db);
    await db.query("update users set created_at = now() where id = $1", [cust]);

    const r = await revenueReport({ from: today(), to: today() }, db);
    expect(r.moneyIn).toMatchObject({ totalNpr: 1200, walletNpr: 1200, giftNpr: 0, payments: 2 });
    expect(r.byMethod).toEqual([{ method: "QR (verified by staff)", npr: 1000, count: 1 }, { method: "Counter · cash", npr: 200, count: 1 }]);
    expect(r.promotions.topupBonus).toBe(50);
    expect(r.liability.creditsHeld).toBeGreaterThanOrEqual(1250);
    expect(r.daily).toEqual([{ day: today(), npr: 1200 }]);
    expect(r.customers.paying).toBe(1);
    expect(revenueCsv(r)).toContain(`${today()},1200.00`);
  });

  it("validates ranges and presets", () => {
    expect(validRange("2026-01-01", "2026-01-31")).toEqual({ from: "2026-01-01", to: "2026-01-31" });
    expect(validRange("2026-02-01", "2026-01-01")).toBeNull();
    expect(validRange("2024-01-01", "2026-01-01")).toBeNull();
    expect(validRange("x", "2026-01-01")).toBeNull();
    const p = presetRange("lastmonth", new Date("2026-03-15T06:00:00Z"));
    expect(p).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(presetRange("7d", new Date("2026-03-15T06:00:00Z"))).toEqual({ from: "2026-03-09", to: "2026-03-15" });
  });
});

describe("log out all devices", () => {
  it("refuses sessions issued before the logout, accepts newer ones", async () => {
    const uid = await createUser(db, "+9779841006010");
    await fund(db, uid, 1);
    const old = Math.floor(Date.now() / 1000) - 60;
    expect(await loadUser(uid, old)).not.toBeNull();
    await db.query("update users set sessions_valid_after = now() where id = $1", [uid]);
    expect(await loadUser(uid, old)).toBeNull();
    expect(await loadUser(uid, Math.floor(Date.now() / 1000) + 1)).not.toBeNull();
  });
});
