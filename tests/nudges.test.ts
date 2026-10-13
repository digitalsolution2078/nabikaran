import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, inDays, principalFor } from "./helpers/db";
import type { Db } from "@/lib/db";
import { MockSmsProvider } from "@/lib/providers/sms/mock";
import { setSmsProviderForTests } from "@/lib/providers/sms";
import { MockEmailProvider, setEmailProviderForTests } from "@/lib/providers/email";
import { savePushSubscription, setPushSender } from "@/lib/services/push";
import { getSetting, nudgeSettingsSchema, setSetting } from "@/lib/services/settings";
import { createReminder } from "@/lib/core/reminders";
import { nudgeReport, nudgeStage, runNudges } from "@/lib/services/nudges";

let db: Db;
let close: () => Promise<void> = async () => undefined;
const sms = new MockSmsProvider();
const mail = new MockEmailProvider();
const pushes: string[] = [];
const DAY = 86_400_000;
let admin: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  setSmsProviderForTests(sms);
  setEmailProviderForTests(mail);
  setPushSender(async (_sub, payload) => {
    pushes.push(payload);
    return { statusCode: 201 };
  });
  admin = await createUser(db, "+9779841007000", "admin");
});
afterAll(async () => {
  setSmsProviderForTests(undefined);
  setEmailProviderForTests(undefined);
  setPushSender(null);
  await close();
});

/** The first noon in Nepal (06:15 UTC) at least `days` after the moment given. */
const noonAfter = (from: Date, days: number) => {
  const d = new Date(from.getTime() + days * DAY);
  const noon = new Date(d);
  noon.setUTCHours(6, 15, 0, 0);
  return noon < d ? new Date(noon.getTime() + DAY) : noon;
};
const stages = async (uid: string) =>
  (await db.query<{ key: string }>("select key from user_notices where user_id = $1 and key like 'nudge:%' order by created_at", [uid])).rows.map((r) => r.key.split(":")[1]);

async function signup(phone: string, opts: { email?: string; device?: boolean } = {}) {
  const uid = await createUser(db, phone);
  const { rows } = await db.query<{ created_at: Date }>("select created_at from users where id = $1", [uid]);
  if (opts.email) await db.query("update users set email = $2, email_verified_at = now() where id = $1", [uid, opts.email]);
  if (opts.device) await savePushSubscription(uid, { endpoint: `https://fcm.googleapis.com/fcm/send/${phone}`, keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } }, "test", db);
  return { uid, at: new Date(rows[0].created_at) };
}

describe("first-reminder nudges", () => {
  it("picks the step by account age", () => {
    const s = { first_days: 1, sms_days: 3, last_days: 10, sms: true };
    expect(nudgeStage(0.5, s)).toBeNull();
    expect(nudgeStage(1.2, s)).toBe("first");
    expect(nudgeStage(4, s)).toBe("sms");
    expect(nudgeStage(4, { ...s, sms: false })).toBe("first");
    expect(nudgeStage(12, s)).toBe("last");
  });

  it("the default SMS fits in one message and admins cannot save one that does not", async () => {
    const d = await getSetting("nudges", db);
    expect(d.sms_text.replace("{link}", "nabikaran.org/renewals/new").length).toBeLessThanOrEqual(160);
    expect(nudgeSettingsSchema.safeParse({ ...d, sms_text: "नमस्ते {link}" }).success).toBe(false);
    expect(nudgeSettingsSchema.safeParse({ ...d, sms_text: `${"x".repeat(150)} {link}` }).success).toBe(false);
    expect(nudgeSettingsSchema.safeParse({ ...d, sms_days: 1, first_days: 1 }).success).toBe(false);
  });

  it("first (app + email), then one SMS, then last; once each, one a day, daytime only", async () => {
    const { uid, at } = await signup("+9779841007001", { email: "sita@example.com", device: true });
    // Same day as sign-up: too early.
    await runNudges(db, noonAfter(at, 0));
    expect(await stages(uid)).toEqual([]);
    // Night: nothing.
    const night = noonAfter(at, 1);
    night.setUTCHours(16, 0, 0, 0);
    expect(await runNudges(db, night)).toBe(0);

    await runNudges(db, noonAfter(at, 1));
    expect(await stages(uid)).toEqual(["first"]);
    expect(pushes.at(-1)).toContain("/renewals/new");
    expect(mail.sent.at(-1)).toMatchObject({ to: "sita@example.com" });
    expect(mail.sent.at(-1)!.text).toContain("Turn them off in Settings");
    expect(sms.sent.some((m) => m.to === "+9779841007001")).toBe(false);

    await runNudges(db, noonAfter(at, 2)); // nothing due
    await runNudges(db, noonAfter(at, 3));
    await runNudges(db, noonAfter(at, 4)); // SMS already sent
    expect(await stages(uid)).toEqual(["first", "sms"]);
    const texts = sms.sent.filter((m) => m.to === "+9779841007001");
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toContain("nabikaran.org/renewals/new");
    expect(texts[0].text.length).toBeLessThanOrEqual(160);

    await runNudges(db, noonAfter(at, 10));
    await runNudges(db, noonAfter(at, 11));
    expect(await stages(uid)).toEqual(["first", "sms", "last"]);
  });

  it("stops for people who added a reminder, opted out, or signed up long ago", async () => {
    const added = await signup("+9779841007002");
    await createReminder(principalFor(added.uid), { category: "other", label: "Bike", calendar: "AD", expiryDate: inDays(30), offsets: [1440], channels: ["push"], notes: null, familyMemberLabel: null, localTime: "09:00" }, {}, db);
    const off = await signup("+9779841007003");
    await db.query("update users set nudges_opt_out = true where id = $1", [off.uid]);
    const old = await signup("+9779841007004");
    await db.query("update users set created_at = created_at - interval '45 days' where id = $1", [old.uid]);
    await runNudges(db, noonAfter(added.at, 3));
    expect(await stages(added.uid)).toEqual([]);
    expect(await stages(off.uid)).toEqual([]);
    expect(await stages(old.uid)).toEqual([]);
  });

  it("can be switched off, and the report counts who added a reminder after a nudge", async () => {
    const p = await signup("+9779841007005");
    await setSetting({ id: admin }, "nudges", { ...(await getSetting("nudges", db)), enabled: false }, db);
    expect(await runNudges(db, noonAfter(p.at, 1))).toBe(0);
    await setSetting({ id: admin }, "nudges", { ...(await getSetting("nudges", db)), enabled: true }, db);

    const conv = await signup("+9779841007006");
    await db.query("insert into user_notices (key, user_id, created_at) values ($1, $2, now() - interval '1 day')", [`nudge:first:${conv.uid}`, conv.uid]);
    await createReminder(principalFor(conv.uid), { category: "other", label: "Licence", calendar: "AD", expiryDate: inDays(30), offsets: [1440], channels: ["push"], notes: null, familyMemberLabel: null, localTime: "09:00" }, {}, db);
    const r = await nudgeReport(db);
    expect(r.nudged).toBeGreaterThanOrEqual(1);
    expect(r.converted).toBeGreaterThanOrEqual(1);
    expect(r.byStage.first).toBeGreaterThanOrEqual(1);
  });
});
