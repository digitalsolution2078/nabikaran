import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, inDays, principalFor, wallet } from "./helpers/db";
import type { Db } from "@/lib/db";
import { getSetting, setSetting } from "@/lib/services/settings";
import { createReminder, setReminderStatus, updateReminder } from "@/lib/core/reminders";
import { recordSummary, listRenewalsForUser } from "@/lib/services/customer-summary";
import { assertCanAddRecords, limitStats, recordUsage } from "@/lib/services/limits";
import { grantPro } from "@/lib/services/plans";
import { commitImport, previewImport } from "@/lib/services/bulk-import";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let admin: string;
const base = { notes: null, familyMemberLabel: null, localTime: "09:00" } as const;
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? String(e));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  admin = await createUser(db, "+9779841009000", "admin");
  await db.query("update users set role = 'super_admin' where id = $1", [admin]);
});
afterAll(async () => close());

describe("records: limits, record only, overview", () => {
  it("defaults are Free 150 and Pro 10,000", async () => {
    expect(await getSetting("limits", db)).toEqual({ free_records: 150, pro_records: 10000 });
  });

  it("a record can be kept without reminders: no messages, no credits, past dates allowed", async () => {
    const uid = await createUser(db, "+9779841009001");
    const { reminder } = await createReminder(principalFor(uid), { category: "passport", label: "Passport", calendar: "AD", expiryDate: inDays(900), offsets: [], channels: ["sms"], ...base }, {}, db);
    expect(reminder.jobs).toEqual([]);
    expect(await wallet(db, uid)).toMatchObject({ posted: 0, reserved: 0 });
    const old = await createReminder(principalFor(uid), { category: "licence", label: "Old licence", calendar: "AD", expiryDate: inDays(-20), offsets: [], channels: ["sms"], ...base }, {}, db);
    expect(old.reminder.jobs).toEqual([]);
    // Turning reminders on later works like any edit.
    await fund(db, uid, 20);
    const on = await updateReminder(principalFor(uid), reminder.id, { category: "passport", label: "Passport", calendar: "AD", expiryDate: inDays(900), offsets: [30 * 1440], channels: ["sms"], ...base }, {}, db);
    expect(on.reminder.jobs.length).toBe(1);
  });

  it("the overview counts valid, expiring, expired and record-only, by type", async () => {
    const uid = await createUser(db, "+9779841009002");
    await fund(db, uid, 50);
    const p = principalFor(uid);
    await createReminder(p, { category: "bluebook", label: "Bike", calendar: "AD", expiryDate: inDays(10), offsets: [1440], channels: ["sms"], ...base }, {}, db);
    await createReminder(p, { category: "insurance", label: "Bike insurance", calendar: "AD", expiryDate: inDays(200), offsets: [], channels: ["sms"], ...base }, {}, db);
    await createReminder(p, { category: "passport", label: "Old passport", calendar: "AD", expiryDate: inDays(-5), offsets: [], channels: ["sms"], ...base }, {}, db);
    const s = await recordSummary(uid, db);
    expect(s).toMatchObject({ total: 3, valid: 1, expiring: 1, expired: 1, remindersOff: 2 });
    expect(s.byGroup).toEqual({ vehicle: 1, insurance: 1, personal: 1 });
    const off = await listRenewalsForUser(uid, { filter: "all", remindersOff: true }, db);
    expect(off.map((r) => r.label).sort()).toEqual(["Bike insurance", "Old passport"]);
    expect(off.every((r) => !r.remindersOn)).toBe(true);
    const vehicles = await listRenewalsForUser(uid, { filter: "all", categoryGroup: "vehicle" }, db);
    expect(vehicles.map((r) => r.label)).toEqual(["Bike"]);
  });

  it("Free accounts stop at the limit (deleted records free up room); Pro gets the higher limit", async () => {
    await setSetting({ id: admin }, "limits", { free_records: 3, pro_records: 5 }, db);
    const uid = await createUser(db, "+9779841009003");
    const p = principalFor(uid);
    const add = (i: number) => createReminder(p, { category: "other", label: `R${i}`, calendar: "AD", expiryDate: inDays(100), offsets: [], channels: ["sms"], ...base }, {}, db);
    const first = await add(1);
    await add(2);
    await add(3);
    expect(await code(add(4))).toBe("record_limit");
    expect(await recordUsage(uid, db)).toMatchObject({ used: 3, limit: 3, pro: false, proLimit: 5 });
    expect(await limitStats(db)).toMatchObject({ overFree: expect.any(Number) });
    await setReminderStatus(p, first.reminder.id, "delete", {}, db);
    expect(await code(add(4))).toBe("ok");
    await grantPro({ id: admin }, uid, { days: 30, withAllowances: false, note: "test" }, db);
    expect((await recordUsage(uid, db)).limit).toBe(5);
    expect(await code(add(5))).toBe("ok");
    expect(await code(assertCanAddRecords(db, uid, 2))).toBe("record_limit");
    await setSetting({ id: admin }, "limits", { free_records: 150, pro_records: 10000 }, db);
  });

  it("an import that would pass the limit is refused before anything is saved", async () => {
    await setSetting({ id: admin }, "limits", { free_records: 2, pro_records: 10 }, db);
    const uid = await createUser(db, "+9779841009004");
    await fund(db, uid, 100);
    const req = { csv: `name,date\nA,${inDays(40)}\nB,${inDays(41)}\nC,${inDays(42)}`, defaults: { calendar: "AD" as const, category: "other" as const, localTime: "09:00", offsetsDays: [1], repeatYearly: false } };
    const pr = await previewImport(principalFor(uid), req, db);
    expect(pr.records).toMatchObject({ used: 0, limit: 2, room: 2 });
    expect(await code(commitImport(principalFor(uid), req, {}, db))).toBe("record_limit");
    expect((await recordUsage(uid, db)).used).toBe(0);
    await setSetting({ id: admin }, "limits", { free_records: 150, pro_records: 10000 }, db);
  });
});
