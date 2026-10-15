import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser } from "./helpers/db";
import type { Db } from "@/lib/db";
import { AakashSmsProvider } from "@/lib/providers/sms/aakash";
import { MockSmsProvider } from "@/lib/providers/sms/mock";
import { meteredSmsProvider } from "@/lib/providers/sms";
import { meteredEmailProvider, MockEmailProvider } from "@/lib/providers/email";
import { messageKind, type UsageRow } from "@/lib/providers/usage";
import { setPushSender } from "@/lib/services/push";
import { getSetting, setSetting } from "@/lib/services/settings";
import { checkSmsBalance, runSmsBalanceWatch, usageReport } from "@/lib/services/message-usage";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let admin: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  setPushSender(async () => ({ statusCode: 201 }));
  admin = await createUser(db, "+9779841011000", "admin");
  await db.query("update users set role = 'super_admin' where id = $1", [admin]);
});
afterAll(async () => {
  setPushSender(null);
  await close();
});

const aakash = (body: unknown, status = 200) => new AakashSmsProvider({
  authToken: "tok", sendUrl: "https://x/send", reportUrl: "https://x/report", creditUrl: "https://x/credit",
  fetchImpl: (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch,
});

describe("message usage", () => {
  it("reads the Aakash balance in the shapes Aakash answers with", async () => {
    expect(await aakash({ available_credit: 1234, total_sms_sent: 99, response_code: 202 }).balance()).toMatchObject({ available: 1234, totalSent: 99 });
    expect(await aakash({ error: false, data: { available_credit: "5,000" } }).balance()).toMatchObject({ available: 5000 });
    await expect(aakash({ error: true, message: "Invalid token" }).balance()).rejects.toThrow(/Invalid token/);
    await expect(aakash("nope", 401).balance()).rejects.toThrow(/refused the token/);
  });

  it("names what each message was for", () => {
    expect(["sms:j:1", "email-j", "otp:+977:1", "code:1", "nudge:sms:u", "low-credit:last:j", "welcome:u", "digest-u-d", "admin-test:a:1", "x"].map(messageKind))
      .toEqual(["reminder", "reminder", "sign_in", "sign_in", "nudge", "low_credit", "welcome", "digest", "test", "other"]);
  });

  it("counts every SMS and email that is not a reminder", async () => {
    const rows: UsageRow[] = [];
    const sms = meteredSmsProvider(new MockSmsProvider(), async (r) => { rows.push(r); });
    await sms.send({ to: "+9779841011001", text: "code 123456", idempotencyKey: "otp:+9779841011001:1" });
    await sms.send({ to: "+9779841011001", text: "reminder", idempotencyKey: "sms:job:1" });
    await sms.send({ to: "+9779841011000", text: "x", idempotencyKey: "welcome:u" }); // mock rejects numbers ending 00
    const mail = meteredEmailProvider(new MockEmailProvider(), async (r) => { rows.push(r); });
    await mail.send({ to: "a@example.com", subject: "s", text: "t", idempotencyKey: "nudge:first:u" });
    expect(rows.map((r) => [r.channel, r.kind, r.outcome])).toEqual([["sms", "sign_in", "accepted"], ["sms", "welcome", "rejected"], ["email", "nudge", "accepted"]]);
    expect(typeof sms.balance).toBe("function");
  });

  it("checks the balance, keeps the history and alerts super admins once a day when low", async () => {
    const mock = new MockSmsProvider();
    mock.startingBalance = 300;
    await setSetting({ id: admin }, "usage", { ...(await getSetting("usage", db)), low_balance: 500, alert: true }, db);
    const t0 = new Date("2026-10-14T05:00:00Z");
    expect(await runSmsBalanceWatch(db, t0, mock)).toBe(1);
    // Within the hour: no new check.
    expect(await runSmsBalanceWatch(db, new Date(t0.getTime() + 30 * 60_000), mock)).toBe(0);
    // Next hour, same Nepal day: checked again but no second alert.
    expect(await runSmsBalanceWatch(db, new Date(t0.getTime() + 2 * 3_600_000), mock)).toBe(0);
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from sms_balance_checks");
    expect(rows[0].n).toBe(2);
    const noApi = { name: "x", send: mock.send.bind(mock), report: mock.report.bind(mock) };
    expect(await checkSmsBalance(db, noApi)).toBeNull();
  });

  it("reports every channel: sent, failed, units, charged and our cost", async () => {
    await setSetting({ id: admin }, "usage", { alert: true, low_balance: 500, sms_cost: 0.5, whatsapp_cost: 1, email_cost: 0.1 }, db);
    await db.query(`insert into message_usage (channel, kind, provider, outcome, segments, units) values
      ('sms','sign_in','mock','accepted',1,1), ('sms','sign_in','mock','accepted',1,null), ('sms','nudge','mock','accepted',2,null),
      ('sms','welcome','mock','rejected',1,null), ('email','digest','mock','accepted',1,null)`);
    const r = await usageReport(30, db);
    const sms = r.channels.find((c) => c.channel === "sms")!;
    expect(sms).toMatchObject({ sent: 3, failed: 1, units: 4, costNpr: 2 });
    expect(r.channels.find((c) => c.channel === "email")).toMatchObject({ sent: 1, units: 1, costNpr: 0.1 });
    expect(r.byKind.find((k) => k.channel === "sms" && k.kind === "nudge")).toMatchObject({ sent: 1, units: 2 });
    expect(r.balance?.available).toBe(300);
    expect(r.daily.length).toBeGreaterThanOrEqual(30);
    expect(r.daily.reduce((n, d) => n + d.sms, 0)).toBe(4);
  });
});
