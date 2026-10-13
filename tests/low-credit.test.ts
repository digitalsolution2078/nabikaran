import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, inDays, principalFor } from "./helpers/db";
import type { Db } from "@/lib/db";
import { MockSmsProvider } from "@/lib/providers/sms/mock";
import { setSmsProviderForTests } from "@/lib/providers/sms";
import { MockEmailProvider, setEmailProviderForTests } from "@/lib/providers/email";
import { savePushSubscription, setPushSender } from "@/lib/services/push";
import { getSetting, setSetting } from "@/lib/services/settings";
import { createReminder } from "@/lib/core/reminders";
import { retryAwaitingCredits } from "@/lib/core/wallet";
import { findShortfalls, runLowCreditAlerts, stageFor } from "@/lib/services/low-credit";
import { runReconciler } from "@/lib/services/dispatcher";

let db: Db;
let close: () => Promise<void> = async () => undefined;
const sms = new MockSmsProvider();
const mail = new MockEmailProvider();
const pushes: string[] = [];
const base = { notes: null, familyMemberLabel: null, localTime: "09:00" } as const;
const DAY = 86_400_000;
let admin: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb({ decimalPricing: true }));
  setSmsProviderForTests(sms);
  setEmailProviderForTests(mail);
  setPushSender(async (_sub, payload) => {
    pushes.push(payload);
    return { statusCode: 201 };
  });
  admin = await createUser(db, "+9779841005000", "admin");
});
afterAll(async () => {
  setSmsProviderForTests(undefined);
  setEmailProviderForTests(undefined);
  setPushSender(null);
  await close();
});

/** 10:00 Nepal time (04:15 UTC), `days` before the given moment's day. */
const nepal10 = (due: string, days: number) => {
  const d = new Date(new Date(due).getTime() - days * DAY);
  d.setUTCHours(4, 15, 0, 0);
  return d;
};
const notices = async (uid: string) =>
  (await db.query<{ key: string }>("select key from user_notices where user_id = $1 and key like 'low-credit:%' order by created_at", [uid])).rows.map((r) => r.key.split(":")[1]);

async function shortCustomer(phone: string, opts: { email?: string; device?: boolean } = {}) {
  const uid = await createUser(db, phone);
  if (opts.email) await db.query("update users set email = $2, email_verified_at = now() where id = $1", [uid, opts.email]);
  if (opts.device) await savePushSubscription(uid, { endpoint: `https://fcm.googleapis.com/fcm/send/${phone}`, keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } }, "test", db);
  await fund(db, uid, 3);
  const { reminder } = await createReminder(principalFor(uid), { category: "other", label: "Bike bluebook", calendar: "AD", expiryDate: inDays(20), offsets: [1440, 2880], ...base }, {}, db);
  // In real use this is the next cycle of a yearly / repeating reminder planned
  // when the wallet is empty: the messages exist but are not funded.
  for (const j of reminder.jobs) {
    await db.query("select wallet_release_for_job($1)", [j.id]);
    await db.query("update reminder_jobs set status = 'awaiting_credits' where id = $1", [j.id]);
  }
  await db.query("update wallets set posted_balance_credits = 0, reserved_credits = 0 where user_id = $1", [uid]);
  const { rows: first } = await db.query<{ d: unknown }>("select min(due_at_utc) as d from reminder_jobs where user_id = $1", [uid]);
  const due = (first[0].d instanceof Date ? first[0].d : new Date(String(first[0].d))).toISOString();
  return { uid, due };
}

describe("low-credit alerts", () => {
  it("stages follow the first waiting reminder's due date", () => {
    const now = new Date("2026-10-13T04:15:00Z");
    expect(stageFor(new Date(now.getTime() + 10 * DAY), now, 2)).toBe("new");
    expect(stageFor(new Date(now.getTime() + 7 * DAY), now, 2)).toBe("soon");
    expect(stageFor(new Date(now.getTime() + 2 * DAY), now, 2)).toBe("last");
  });

  it("works out what is short and a top-up amount of at least the minimum", async () => {
    const { uid } = await shortCustomer("+9779841005001");
    const [s] = await findShortfalls(db, new Date(), uid);
    expect(s).toMatchObject({ userId: uid, waiting: 2, needed: 3, topUpNpr: 20 });
  });

  it("tells the customer step by step: new → soon → last call (with one SMS), never twice", async () => {
    const { uid, due } = await shortCustomer("+9779841005002", { email: "ram@example.com", device: true });
    const mailBefore = mail.sent.length;

    // Night in Nepal: nothing goes out.
    const night = nepal10(due, 15);
    night.setUTCHours(17, 0, 0, 0);
    expect(await runLowCreditAlerts(db, night)).toBe(0);

    // First notice: app notification + email, no SMS.
    const t1 = nepal10(due, 15);
    expect(await runLowCreditAlerts(db, t1)).toBeGreaterThanOrEqual(1);
    expect(await notices(uid)).toEqual(["new"]);
    expect(pushes.at(-1)).toContain("/wallet?amount=20");
    const email = mail.sent.slice(mailBefore).find((m) => m.to === "ram@example.com")!;
    expect(email.subject).toContain("2 reminders cannot be sent");
    expect(email.text).toContain("Credits needed: 3");
    expect(sms.sent.some((m) => m.to === "+9779841005002")).toBe(false);

    // Same day again: nothing new.
    expect(await notices(uid)).toEqual(["new"]);
    await runLowCreditAlerts(db, new Date(t1.getTime() + 3600_000));
    expect(await notices(uid)).toEqual(["new"]);

    // A week before: reminder again.
    await runLowCreditAlerts(db, nepal10(due, 5));
    expect(await notices(uid)).toEqual(["new", "soon"]);
    expect(sms.sent.some((m) => m.to === "+9779841005002")).toBe(false);

    // Last call: also one SMS with the wallet link.
    await runLowCreditAlerts(db, nepal10(due, 1));
    await runLowCreditAlerts(db, nepal10(due, 0.5));
    expect(await notices(uid)).toEqual(["new", "soon", "last"]);
    const texts = sms.sent.filter((m) => m.to === "+9779841005002");
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toMatch(/2 reminders cannot be sent .*Top up NPR 20: .*\/wallet$/);

    const { rows } = await db.query<{ d: { stage: string; channels: string[] } }>(
      "select json_detail_redacted as d from audit_events where action = 'low_credit.alert' and target_id = $1 order by created_at", [uid],
    );
    expect(rows.map((r) => (typeof r.d === "string" ? JSON.parse(r.d) : r.d).stage)).toEqual(["new", "soon", "last"]);
    expect((typeof rows[2].d === "string" ? JSON.parse(rows[2].d) : rows[2].d).channels).toEqual(["push", "email", "sms"]);
  });

  it("stops once the customer tops up", async () => {
    const { uid, due } = await shortCustomer("+9779841005003");
    await fund(db, uid, 50);
    await retryAwaitingCredits(uid, db);
    expect(await findShortfalls(db, new Date(), uid)).toEqual([]);
    await runLowCreditAlerts(db, nepal10(due, 1));
    expect(await notices(uid)).toEqual([]);
  });

  it("skips Pro messages waiting for permission, and does nothing when switched off", async () => {
    const { uid } = await shortCustomer("+9779841005004");
    await db.query("update reminder_jobs set last_error = 'included messages used up: allow wallet credits' where user_id = $1", [uid]);
    expect(await findShortfalls(db, new Date(), uid)).toEqual([]);

    const other = await shortCustomer("+9779841005005");
    await setSetting({ id: admin }, "low_credit", { ...(await getSetting("low_credit", db)), enabled: false }, db);
    expect(await runLowCreditAlerts(db, nepal10(other.due, 3))).toBe(0);
    expect(await notices(other.uid)).toEqual([]);
    await setSetting({ id: admin }, "low_credit", { enabled: true, sms_last_call: false, last_call_days: 2 }, db);
    await runLowCreditAlerts(db, nepal10(other.due, 1));
    expect(await notices(other.uid)).toEqual(["last"]);
    expect(sms.sent.some((m) => m.to === "+9779841005005")).toBe(false);
  });

  it("the reconciler runs the alerts", async () => {
    const { due } = await shortCustomer("+9779841005006");
    const out = await runReconciler(db, nepal10(due, 10));
    expect(out.lowCreditAlerts).toBeGreaterThanOrEqual(1);
  });
});
