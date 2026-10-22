import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, inDays, principalFor } from "./helpers/db";
import type { Db } from "@/lib/db";
import { savePushSubscription, setPushSender } from "@/lib/services/push";
import { createReminder, markRenewed } from "@/lib/core/reminders";
import { followupStage, runRenewalFollowups } from "@/lib/services/followups";
import { funnelReport, cleanSource } from "@/lib/services/funnel";

let db: Db;
let close: () => Promise<void> = async () => undefined;
const pushes: Array<{ title: string; url?: string }> = [];
const base = { notes: null, familyMemberLabel: null, localTime: "09:00" } as const;
const DAY = 86_400_000;
/** Noon in Nepal, `days` after `from`. */
const noon = (from: Date, days: number) => { const d = new Date(from.getTime() + days * DAY); d.setUTCHours(6, 15, 0, 0); return d; };
const keys = async (id: string) => (await db.query<{ key: string }>("select key from user_notices where key like $1 order by created_at", [`followup:%:${id}`])).rows.map((r) => r.key.split(":")[1]);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  setPushSender(async (_sub, payload) => { pushes.push(JSON.parse(payload)); return { statusCode: 201 }; });
});
afterAll(async () => { setPushSender(null); await close(); });

describe("did-you-renew follow-ups", () => {
  it("picks the step by days since expiry; vehicle tax gets the late-fine step", () => {
    const s = { days: [3, 30], tax_days: 80 };
    expect(followupStage(1, "passport", s)).toBeNull();
    expect(followupStage(3.5, "passport", s)).toBe(3);
    expect(followupStage(31, "passport", s)).toBe(30);
    expect(followupStage(85, "passport", s)).toBe(30);
    expect(followupStage(85, "vehicle_tax", s)).toBe(80);
  });

  it("follows up once per step, only for one-time records, in Nepali for Nepali users, and stops once marked renewed", async () => {
    const u = await createUser(db, "+9779841012001");
    await db.query("update users set locale = 'ne-NP' where id = $1", [u]);
    await fund(db, u, 100);
    await savePushSubscription(u, { endpoint: "https://fcm.googleapis.com/fcm/send/f1", keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } }, "test", db);
    const { reminder: once } = await createReminder(principalFor(u), { category: "passport", label: "Passport", calendar: "AD", expiryDate: inDays(2), offsets: [1440], channels: ["push"], ...base }, {}, db);
    const { reminder: yearly } = await createReminder(principalFor(u), { category: "bluebook", label: "Bluebook", calendar: "AD", expiryDate: inDays(2), offsets: [1440], channels: ["push"], repeatYearly: true, ...base }, {}, db);
    const expiry = new Date(inDays(2) + "T03:15:00Z");
    expect(await runRenewalFollowups(db, noon(expiry, 1))).toBe(0);
    expect(await runRenewalFollowups(db, noon(expiry, 4))).toBe(1);
    expect(await runRenewalFollowups(db, noon(expiry, 5))).toBe(0); // same step, already sent
    expect(await keys(once.id)).toEqual(["3"]);
    expect(await keys(yearly.id)).toEqual([]);
    expect(pushes.at(-1)!.title).toContain("नवीकरण गर्नुभयो");
    expect(pushes.at(-1)!.url).toBe(`/renewals/${once.id}`);
    // Night: nothing.
    const night = noon(expiry, 31); night.setUTCHours(16, 0, 0, 0);
    expect(await runRenewalFollowups(db, night)).toBe(0);
    expect(await runRenewalFollowups(db, noon(expiry, 31))).toBe(1);
    expect(await keys(once.id)).toEqual(["3", "30"]);
    // Marked renewed (free) with a new date: no more follow-ups.
    await db.query("update renewal_items set expiry_at_utc = $2 where id = $1", [once.id, new Date(Date.now() - 40 * DAY).toISOString()]);
    await markRenewed(principalFor(u), once.id, { renewedOn: inDays(0), nextExpiryDate: inDays(300) }, db);
    expect(await runRenewalFollowups(db, noon(new Date(), 1))).toBe(0);
  });

  it("the funnel counts sign-ups, first records, top-ups and sources", async () => {
    const a = await createUser(db, "+9779841012010");
    await db.query("update users set signup_source = 'facebook' where id = $1", [a]);
    await fund(db, a, 50);
    await createReminder(principalFor(a), { category: "other", label: "X", calendar: "AD", expiryDate: inDays(30), offsets: [1440], channels: ["push"], ...base }, {}, db);
    await createUser(db, "+9779841012011");
    const r = await funnelReport(30, db);
    expect(r.signups).toBeGreaterThanOrEqual(3);
    expect(r.firstRecord).toBeGreaterThanOrEqual(2);
    expect(r.firstTopup).toBeGreaterThanOrEqual(1);
    expect(r.sources.find((s) => s.source === "facebook")).toMatchObject({ signups: 1, withRecord: 1 });
    expect(cleanSource("Facebook%2Flaunch")).toBe("facebook/launch");
    expect(cleanSource("<script>")).toBe("script");
  });
});

describe("free monthly push and Nepal templates", () => {
  it("free accounts with a device get one 'due this month' notification per month", async () => {
    const { runFreeMonthlyPush } = await import("@/lib/services/digest");
    const u = await createUser(db, "+9779841012020");
    await fund(db, u, 20);
    await savePushSubscription(u, { endpoint: "https://fcm.googleapis.com/fcm/send/m1", keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } }, "test", db);
    const noon = new Date(); noon.setUTCHours(6, 15, 0, 0);
    await runFreeMonthlyPush(db, noon); // other test users get theirs; ours has nothing due yet
    await createReminder(principalFor(u), { category: "bluebook", label: "Bluebook", calendar: "AD", expiryDate: inDays(12), offsets: [1440], channels: ["push"], ...base }, {}, db);
    const before = pushes.length;
    expect(await runFreeMonthlyPush(db, noon)).toBe(1);
    expect(pushes.length).toBe(before + 1);
    expect(pushes.at(-1)!.url).toBe("/renewals?filter=due");
    expect(await runFreeMonthlyPush(db, noon)).toBe(0); // once a month
  });

  it("the Nepal templates and their office/fee notes are there", async () => {
    const { listDocTemplates, templateInfo } = await import("@/lib/services/admin-console");
    const slugs = (await listDocTemplates(false, db)).map((t) => t.slug);
    for (const s of ["ward-business-registration", "pollution-check", "electricity-bill", "sim-validity", "bank-kyc", "ssf-contribution"]) expect(slugs).toContain(s);
    expect((await templateInfo("vehicle-tax", db))?.ne).toContain("यातायात");
    expect(await templateInfo("domain", db)).toBeNull();
  });
});
