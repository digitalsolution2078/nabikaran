import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, wallet, principalFor, inDays } from "./helpers/db";
import type { Db } from "@/lib/db";
import { MockSmsProvider } from "@/lib/providers/sms/mock";
import { setSmsProviderForTests } from "@/lib/providers/sms";
import { createReminder, previewSchedule } from "@/lib/core/reminders";
import { runDispatcher } from "@/lib/services/dispatcher";
import { resetVapidCache, savePushSubscription, setPushSender } from "@/lib/services/push";
import { listMcpConnectionsForAdmin } from "@/lib/oauth/tokens";

let db: Db;
let close: () => Promise<void> = async () => undefined;
const sms = new MockSmsProvider();
const pushed: string[] = [];
const base = { notes: null, familyMemberLabel: null, localTime: "09:00" } as const;
const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/free-1", keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  setSmsProviderForTests(sms);
  resetVapidCache();
  setPushSender(async (s, payload) => { pushed.push(`${s.endpoint}|${payload}`); return { statusCode: 201 }; });
});
afterAll(async () => {
  setSmsProviderForTests(undefined);
  setPushSender(null);
  resetVapidCache();
  await close();
});

describe("free app-notification channel", () => {
  it("costs nothing and is saved with an empty wallet", async () => {
    const uid = await createUser(db, "+9779841000901");
    const p = principalFor(uid);
    const pv = await previewSchedule(p, { label: "Bluebook", calendar: "AD", expiryDate: inDays(40), localTime: "09:00", offsets: [7 * 1440, 1440], channels: ["push"] }, db);
    expect(pv.lines.every((l) => l.channel === "push" && l.credits === 0)).toBe(true);
    expect(pv.totalCredits).toBe(0);
    expect(pv.warnings).not.toContain("insufficient_credits");
    expect(pv.warnings).toContain("push_no_device");

    const { reminder } = await createReminder(p, { category: "bluebook", label: "Bluebook", calendar: "AD", expiryDate: inDays(40), offsets: [7 * 1440, 1440], channels: ["push"], ...base }, {}, db);
    expect(reminder.jobs.every((j) => j.channel === "push" && j.status === "scheduled")).toBe(true);
    expect((await wallet(db, uid)).reserved).toBe(0);
    const { rows } = await db.query("select 1 from credit_reservations r join reminder_jobs j on j.id = r.reminder_job_id where j.renewal_id = $1", [reminder.id]);
    expect(rows).toHaveLength(0);
  });

  it("is never blocked by a negative balance", async () => {
    const uid = await createUser(db, "+9779841000902");
    await db.query("select wallet_charge_signin_fee($1, gen_random_uuid(), 1)", [uid]);
    expect((await wallet(db, uid)).available).toBeLessThan(0);
    const { reminder } = await createReminder(principalFor(uid), { category: "other", label: "Rent", calendar: "AD", expiryDate: inDays(10), offsets: [1440], channels: ["push"], ...base }, {}, db);
    expect(reminder.jobs[0].status).toBe("scheduled");
  });

  it("is delivered as a push with no SMS and no charge; fails cleanly without a device", async () => {
    const withDevice = await createUser(db, "+9779841000903");
    const noDevice = await createUser(db, "+9779841000904");
    await savePushSubscription(withDevice, sub, "test", db);
    for (const uid of [withDevice, noDevice]) {
      await createReminder(principalFor(uid), { category: "other", label: "Tax", calendar: "AD", expiryDate: inDays(3), offsets: [2 * 1440], channels: ["push"], ...base }, {}, db);
    }
    await db.query("update reminder_jobs set due_at_utc = now() - interval '1 minute' where channel = 'push' and user_id = any($1)", [[withDevice, noDevice]]);
    const smsBefore = sms.sent.length;
    await runDispatcher(db, new Date());
    expect(sms.sent.length).toBe(smsBefore);
    expect(pushed.filter((x) => x.startsWith(sub.endpoint))).toHaveLength(1);
    const { rows } = await db.query<{ user_id: string; status: string }>("select user_id, status from reminder_jobs where channel = 'push' and user_id = any($1)", [[withDevice, noDevice]]);
    expect(rows.find((r) => r.user_id === withDevice)?.status).toBe("delivered");
    expect(rows.find((r) => r.user_id === noDevice)?.status).toBe("failed");
    const { rows: led } = await db.query("select 1 from wallet_ledger where user_id = any($1) and type = 'debit'", [[withDevice, noDevice]]);
    expect(led).toHaveLength(0);
  });
});

describe("admin: MCP connections", () => {
  it("lists who connected which app", async () => {
    const uid = await createUser(db, "+9779841000905");
    await db.query("update users set display_name = 'Sita' where id = $1", [uid]);
    await db.query("insert into oauth_clients (id, name, redirect_uris) values ('cl_test', 'Claude', array['https://claude.ai/cb'])");
    await db.query(
      "insert into oauth_tokens (token_hash, kind, client_id, user_id, scopes, expires_at, family_id, resource) values ('h1','refresh','cl_test',$1,array['reminders:read','reminders:write'], now() + interval '30 days', gen_random_uuid(), 'https://nabikaran.org/mcp')",
      [uid],
    );
    const all = await listMcpConnectionsForAdmin({}, db);
    const mine = all.find((r) => r.userId === uid);
    expect(mine).toMatchObject({ userName: "Sita", phone: "+9779841000905", clientName: "Claude" });
    expect(mine?.scopes).toEqual(["reminders:read", "reminders:write"]);
    expect(await listMcpConnectionsForAdmin({ userId: uid }, db)).toHaveLength(1);
  });
});
