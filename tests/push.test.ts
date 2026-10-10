import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, wallet } from "./helpers/db";
import type { Db } from "@/lib/db";
import { MockSmsProvider } from "@/lib/providers/sms/mock";
import { setSmsProviderForTests } from "@/lib/providers/sms";
import { runDispatcher } from "@/lib/services/dispatcher";
import { getVapidKeys, isPushServiceUrl, resetVapidCache, savePushSubscription, sendPushToUser, setPushSender, subscriptionSchema, deviceCount, removePushSubscription } from "@/lib/services/push";

let db: Db;
let close: () => Promise<void> = async () => undefined;
const sms = new MockSmsProvider();
const sent: Array<{ endpoint: string; payload: string }> = [];
let failWith: number | null = null;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  setSmsProviderForTests(sms);
  resetVapidCache();
  setPushSender(async (sub, payload) => {
    if (failWith) throw Object.assign(new Error("push failed"), { statusCode: failWith });
    sent.push({ endpoint: sub.endpoint, payload });
    return { statusCode: 201 };
  });
});
afterAll(async () => {
  setSmsProviderForTests(undefined);
  setPushSender(null);
  resetVapidCache();
  await close();
});

const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`, keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } });

async function dueJob(uid: string) {
  await fund(db, uid, 30);
  const { rows: r } = await db.query<{ id: string }>("insert into renewal_items (owner_user_id, category, label, expiry_at_utc) values ($1,'other','Thing',$2) returning id", [uid, new Date(Date.now() + 86_400_000).toISOString()]);
  const { rows: rule } = await db.query<{ id: string }>("insert into reminder_rules (renewal_id, offset_minutes) values ($1, 1440) returning id", [r[0].id]);
  const { rows: job } = await db.query<{ id: string }>(
    "insert into reminder_jobs (renewal_id, rule_id, user_id, cycle_no, due_at_utc, estimated_segments, estimated_credits) values ($1,$2,$3,1,$4,2,6) returning id",
    [r[0].id, rule[0].id, uid, new Date(Date.now() - 5 * 60_000).toISOString()],
  );
  await db.query("select wallet_reserve_for_job($1)", [job[0].id]);
  return { renewalId: r[0].id, jobId: job[0].id };
}

describe("web push", () => {
  it("creates one VAPID key pair and keeps it", async () => {
    const a = await getVapidKeys(db);
    resetVapidCache();
    const b = await getVapidKeys(db);
    expect(a.publicKey).toBe(b.publicKey);
    expect(a.publicKey.length).toBeGreaterThan(80);
    const { rows } = await db.query("select key from app_secrets");
    expect(rows).toHaveLength(1);
  });

  it("accepts browser push services only", () => {
    expect(isPushServiceUrl("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isPushServiceUrl("https://web.push.apple.com/QO")).toBe(true);
    expect(isPushServiceUrl("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isPushServiceUrl("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(true);
    expect(isPushServiceUrl("https://nabikaran-db-1/x")).toBe(false);
    expect(isPushServiceUrl("http://fcm.googleapis.com/x")).toBe(false);
    expect(isPushServiceUrl("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(isPushServiceUrl("https://evilfcm.googleapis.com.example.com/x")).toBe(false);
    expect(subscriptionSchema.safeParse({ endpoint: "https://169.254.169.254/latest", keys: sub(1).keys }).success).toBe(false);
  });

  it("sends one free push per reminder occurrence; SMS and credits are unchanged", async () => {
    const uid = await createUser(db, "+9779841000801");
    expect(await savePushSubscription(uid, sub(1), "test", db)).toBe(1);
    expect(await savePushSubscription(uid, sub(1), "test", db)).toBe(1); // same device again
    const { renewalId, jobId } = await dueJob(uid);
    const smsBefore = sms.sent.length;
    const s = await runDispatcher(db, new Date());
    expect(s.submitted).toBe(1);
    expect(sms.sent.length).toBe(smsBefore + 1);
    const mine = sent.filter((x) => x.endpoint === sub(1).endpoint);
    expect(mine).toHaveLength(1);
    const payload = JSON.parse(mine[0].payload);
    expect(payload).toMatchObject({ title: "Nabikaran", url: `/renewals/${renewalId}` });
    expect(payload.body).toContain("Thing");
    // Charged exactly the quote, as without push.
    expect((await wallet(db, uid)).posted).toBe(24);
    await db.query("update reminder_jobs set status = 'scheduled' where id = $1", [jobId]);
    // A repeated occurrence (e.g. the WhatsApp copy) is not pushed twice.
    const { pushReminders } = await import("@/lib/services/push");
    const due = (await db.query<{ due_at_utc: string }>("select due_at_utc from reminder_jobs where id = $1", [jobId])).rows[0].due_at_utc;
    expect(await pushReminders([{ userId: uid, renewalId, occurrenceKey: `${renewalId}:1:${new Date(due).toISOString()}`, body: "x" }], db)).toBe(0);
  });

  it("does nothing for a customer without devices", async () => {
    const uid = await createUser(db, "+9779841000802");
    await dueJob(uid);
    const before = sent.length;
    expect((await runDispatcher(db, new Date())).submitted).toBe(1);
    expect(sent.length).toBe(before);
    const { rows } = await db.query("select 1 from push_deliveries where user_id = $1", [uid]);
    expect(rows).toHaveLength(0);
  });

  it("removes expired devices and never breaks the SMS send", async () => {
    const uid = await createUser(db, "+9779841000803");
    await savePushSubscription(uid, sub(3), null, db);
    await dueJob(uid);
    failWith = 410;
    const smsBefore = sms.sent.length;
    expect((await runDispatcher(db, new Date())).submitted).toBe(1);
    failWith = null;
    expect(sms.sent.length).toBe(smsBefore + 1);
    expect(await deviceCount(uid, db)).toBe(0);
  });

  it("moves a device to the account that signed in last, and removes it on request", async () => {
    const a = await createUser(db, "+9779841000804");
    const b = await createUser(db, "+9779841000805");
    await savePushSubscription(a, sub(5), null, db);
    await savePushSubscription(b, sub(5), null, db);
    expect(await deviceCount(a, db)).toBe(0);
    expect(await sendPushToUser(b, { title: "t", body: "b", url: "/" }, db)).toBe(1);
    expect(await removePushSubscription(b, sub(5).endpoint, db)).toBe(0);
  });
});
