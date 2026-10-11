import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, inDays, principalFor, wallet } from "./helpers/db";
import type { Db } from "@/lib/db";
import { MockSmsProvider } from "@/lib/providers/sms/mock";
import { setSmsProviderForTests } from "@/lib/providers/sms";
import { createReminder, setReminderStatus } from "@/lib/core/reminders";
import { banInfo, banUser, liftExpiredBans, unbanUser } from "@/lib/services/bans";
import { requestOtp, verifyOtp } from "@/lib/auth/otp";
import { can } from "@/lib/auth/rbac";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let admin: string;
const sms = new MockSmsProvider();
const base = { notes: null, familyMemberLabel: null, localTime: "09:00" } as const;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  setSmsProviderForTests(sms);
  admin = await createUser(db, "+9779841000700", "admin");
});
afterAll(async () => {
  setSmsProviderForTests(undefined);
  await close();
});

const status = async (id: string) => (await db.query<{ status: string }>("select status from users where id = $1", [id])).rows[0].status;
const reminderOf = async (id: string) => (await db.query<{ status: string; ban_paused: boolean }>("select status, ban_paused from renewal_items where id = $1", [id])).rows[0];
const ledgerCount = async (id: string) => Number((await db.query<{ n: string }>("select count(*)::text as n from wallet_ledger where user_id = $1", [id])).rows[0].n);

describe("ban / unban", () => {
  it("keeps everything, pauses active reminders, releases holds, blocks sign-in; unban restores", async () => {
    const phone = "+9779841000701";
    const u = await createUser(db, phone);
    await fund(db, u, 100);
    const { reminder } = await createReminder(principalFor(u), { category: "other", label: "Bluebook", calendar: "AD", expiryDate: inDays(20), offsets: [7 * 1440, 1440], ...base }, {}, db);
    const { reminder: paused } = await createReminder(principalFor(u), { category: "other", label: "Already paused", calendar: "AD", expiryDate: inDays(30), offsets: [1440], ...base }, {}, db);
    await setReminderStatus(principalFor(u), paused.id, "pause", {}, db);
    const before = await wallet(db, u);
    expect(before.reserved).toBeGreaterThan(0);
    const ledgerBefore = await ledgerCount(u);
    const pending = await requestOtp({ phone, ip: "1.1.1.1" }, db); // asked for a code just before the ban

    await expect(banUser({ id: admin }, u, { reason: "no" }, db)).rejects.toMatchObject({ code: "reason_required" });
    const info = await banUser({ id: admin }, u, { reason: "Payment fraud on 3 top-ups" }, db);
    expect(info).toMatchObject({ banned: true, reason: "Payment fraud on 3 top-ups", until: null });
    expect(await status(u)).toBe("suspended");
    expect(await reminderOf(reminder.id)).toEqual({ status: "paused", ban_paused: true });
    expect(await reminderOf(paused.id)).toEqual({ status: "paused", ban_paused: false });
    const after = await wallet(db, u);
    expect(after.reserved).toBe(0);
    expect(after.posted).toBe(before.posted); // nothing taken
    expect(await ledgerCount(u)).toBe(ledgerBefore); // history untouched

    // No SMS code for a banned number, and a code sent before the ban no longer works.
    const sent = sms.sent.length;
    await expect(requestOtp({ phone, ip: "1.1.1.1" }, db)).rejects.toMatchObject({ code: "account_suspended" });
    expect(sms.sent.length).toBe(sent);
    await expect(verifyOtp(phone, pending.devCode!, db)).rejects.toMatchObject({ code: "account_suspended" });

    const un = await unbanUser({ id: admin }, u, "Cleared after review", db);
    expect(un).toMatchObject({ banned: false, resumed: 1, notResumed: 0 });
    expect(await status(u)).toBe("active");
    expect(await reminderOf(reminder.id)).toEqual({ status: "active", ban_paused: false });
    expect(await reminderOf(paused.id)).toEqual({ status: "paused", ban_paused: false }); // stays as the customer left it
    expect((await wallet(db, u)).reserved).toBe(before.reserved);
    expect((await banInfo(u, db)).history.map((h) => h.action)).toEqual(["unban", "ban"]);
    await expect(unbanUser({ id: admin }, u, null, db)).rejects.toMatchObject({ code: "not_banned" });
  });

  it("refuses staff and self; time-limited bans lift themselves", async () => {
    const staff = await createUser(db, "+9779841000702");
    await db.query("update users set role = 'support' where id = $1", [staff]);
    await expect(banUser({ id: admin }, staff, { reason: "testing staff" }, db)).rejects.toMatchObject({ code: "staff_ban" });
    await expect(banUser({ id: admin }, admin, { reason: "testing self" }, db)).rejects.toMatchObject({ code: "self_ban" });

    const u = await createUser(db, "+9779841000703");
    await banUser({ id: admin }, u, { reason: "Spam for a week", until: new Date(Date.now() + 7 * 86_400_000).toISOString() }, db);
    expect(await liftExpiredBans(db)).toBe(0);
    await db.query("update users set ban_until = now() - interval '1 minute' where id = $1", [u]);
    expect(await liftExpiredBans(db)).toBe(1);
    expect(await status(u)).toBe("active");
    expect((await banInfo(u, db)).history[0]).toMatchObject({ action: "unban", actor: null, reason: "Ban period ended" });
  });

  it("only admin and super admin may ban", () => {
    expect(can("super_admin", "users.ban")).toBe(true);
    expect(can("admin", "users.ban")).toBe(true);
    for (const r of ["support", "finance", "counter", "auditor", "content", "user"]) expect(can(r, "users.ban")).toBe(false);
  });
});
