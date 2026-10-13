import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, inDays, principalFor, wallet } from "./helpers/db";
import type { Db } from "@/lib/db";
import { MockSmsProvider } from "@/lib/providers/sms/mock";
import { setSmsProviderForTests } from "@/lib/providers/sms";
import { getSetting, setSetting } from "@/lib/services/settings";
import { buyPro, getPlanState, grantPro, runProCredits, startTrial } from "@/lib/services/plans";
import { createReminder } from "@/lib/core/reminders";
import { runDispatcher } from "@/lib/services/dispatcher";

let db: Db;
let close: () => Promise<void> = async () => undefined;
const sms = new MockSmsProvider();
const base = { notes: null, familyMemberLabel: null, localTime: "09:00" } as const;
let admin: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb({ decimalPricing: true }));
  setSmsProviderForTests(sms);
  admin = await createUser(db, "+9779841004000", "admin");
  await db.query("update users set role = 'super_admin' where id = $1", [admin]);
  await setSetting({ id: admin }, "pro", { ...(await getSetting("pro", db)), enabled: true }, db);
});
afterAll(async () => {
  setSmsProviderForTests(undefined);
  await close();
});

const ledger = async (uid: string) =>
  (await db.query<{ t: string }>("select type || ':' || signed_credits::text as t from wallet_ledger where user_id = $1 order by id", [uid])).rows.map((r) => r.t);
const DAY = 86_400_000;

describe("Pro monthly credits", () => {
  it("the default offer is 30 credits a month and no fixed message counts", async () => {
    const offer = await getSetting("pro", db);
    expect(offer).toMatchObject({ monthly_credits: 30, allowance_sms: 0, allowance_whatsapp: 0, allowance_email: 0 });
  });

  it("buying Pro gives this month's 30 credits at once, exactly once", async () => {
    const uid = await createUser(db, "+9779841004001");
    await fund(db, uid, 1000);
    const r = await buyPro(uid, "buy-1", db);
    expect(r.state).toMatchObject({ tier: "pro", monthlyCredits: 30, allowances: [] });
    expect(r.state.monthGrant?.credits).toBe(30);
    await runProCredits(db);
    await runProCredits(db);
    expect(await ledger(uid)).toEqual(["topup:1000.00", "plan:-1000.00", "pro_credit:30.00"]);
    expect((await wallet(db, uid)).available).toBe(30);
  });

  it("Pro credits pay for messages like any credits (SMS 1.50 each)", async () => {
    const uid = await createUser(db, "+9779841004002");
    await fund(db, uid, 1000);
    await buyPro(uid, "buy-2", db);
    const { reminder } = await createReminder(principalFor(uid), { category: "other", label: "Rent", calendar: "AD", expiryDate: inDays(5), offsets: [1440], ...base }, {}, db);
    expect(reminder.jobs[0].status).toBe("scheduled");
    expect(await wallet(db, uid)).toEqual({ posted: 30, reserved: 1.5, available: 28.5 });
  });

  it("at the end of the plan month the unspent part expires; spent credits and held ones are kept", async () => {
    const uid = await createUser(db, "+9779841004003");
    await fund(db, uid, 1000);
    await buyPro(uid, "buy-3", db);
    const { reminder } = await createReminder(principalFor(uid), { category: "other", label: "Tax", calendar: "AD", expiryDate: inDays(3), offsets: [2 * 1440], ...base }, {}, db);
    await db.query("update reminder_jobs set due_at_utc = now() - interval '1 minute' where id = $1", [reminder.jobs[0].id]);
    await runDispatcher(db, new Date());
    expect((await wallet(db, uid)).posted).toBe(28.5);
    // Jump past the first plan month: 28.50 unspent expires, and next month's 30 arrives.
    const later = new Date(Date.now() + 32 * DAY);
    await runProCredits(db, later);
    const l = await ledger(uid);
    expect(l).toContain("pro_expiry:-28.50");
    expect(l.filter((x) => x === "pro_credit:30.00")).toHaveLength(2);
    expect((await wallet(db, uid)).available).toBe(30);
    await runProCredits(db, later);
    expect((await ledger(uid)).length).toBe(l.length);
  });

  it("expiry never takes paid top-ups or credits held for scheduled messages", async () => {
    const uid = await createUser(db, "+9779841004004");
    await fund(db, uid, 1000);
    await buyPro(uid, "buy-4", db);
    // Hold 10 SMS (15.00 credits) for later messages, so only 15.00 of the 30 is free.
    await createReminder(principalFor(uid), { category: "other", label: "Hold", calendar: "AD", expiryDate: inDays(60), offsets: [1440, 2880, 4320, 5760, 7200, 8640, 10080, 11520, 12960, 14400], ...base }, {}, db);
    expect(await wallet(db, uid)).toEqual({ posted: 30, reserved: 15, available: 15 });
    const g = await db.query<{ id: string }>("select id from pro_credit_grants where user_id = $1", [uid]);
    await db.query("update pro_credit_grants set period_end = now() - interval '1 second', period_start = now() - interval '31 days' where id = $1", [g.rows[0].id]);
    const { rows } = await db.query<{ n: string }>("select pro_expire_grant($1)::text as n", [g.rows[0].id]);
    expect(rows[0].n).toBe("15.00");
    expect(await wallet(db, uid)).toEqual({ posted: 15, reserved: 15, available: 0 });
  });

  it("a trial gives Pro features but no credits; an admin grant with included credits does", async () => {
    const t = await createUser(db, "+9779841004005");
    await startTrial(t, db);
    await runProCredits(db);
    expect((await wallet(db, t)).posted).toBe(0);
    const g = await createUser(db, "+9779841004006");
    const st = await grantPro({ id: admin }, g, { days: 90, withAllowances: true, note: "partner" }, db);
    expect(st.monthGrant?.credits).toBe(30);
    expect((await wallet(db, g)).posted).toBe(30);
    const n = await createUser(db, "+9779841004007");
    await grantPro({ id: admin }, n, { days: 30, withAllowances: false, note: "features only" }, db);
    expect((await wallet(db, n)).posted).toBe(0);
    expect((await getPlanState(n, db)).monthlyCredits).toBe(0);
  });
});
