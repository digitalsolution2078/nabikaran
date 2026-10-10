import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, inDays, principalFor, wallet } from "./helpers/db";
import type { Db } from "@/lib/db";
import { MockSmsProvider } from "@/lib/providers/sms/mock";
import { setSmsProviderForTests } from "@/lib/providers/sms";
import { MockEmailProvider, ResendEmailProvider, setEmailProviderForTests } from "@/lib/providers/email";
import { setSetting } from "@/lib/services/settings";
import { buyPro, getPlanState, grantPro, isPro, revokePlan, startTrial } from "@/lib/services/plans";
import { createReminder, previewSchedule, rolloverYearly, setReminderStatus } from "@/lib/core/reminders";
import { runDispatcher } from "@/lib/services/dispatcher";
import { confirmEmailVerify, emailStatus, requestEmailLogin, requestEmailVerify, verifyEmailLogin } from "@/lib/services/email-auth";
import { listSubscriptions } from "@/lib/services/subscriptions";
import { secretStatus, setSecret, getSecret } from "@/lib/services/secrets";
import { nextEveryMonths } from "@/lib/recurrence";
import { emailConfigured } from "@/lib/core/email-config";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let admin: string;
const sms = new MockSmsProvider();
const mail = new MockEmailProvider();
const base = { notes: null, familyMemberLabel: null, localTime: "09:00" } as const;
const PRO = { enabled: true, price_npr: 1000, duration_days: 365, trial_enabled: true, trial_days: 7, allowance_sms: 100, allowance_whatsapp: 100, allowance_email: 500 };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  setSmsProviderForTests(sms);
  setEmailProviderForTests(mail);
  process.env.EMAIL_PROVIDER = "mock";
  admin = await createUser(db, "+9779841000900", "admin");
  await db.query("update users set role = 'super_admin' where id = $1", [admin]);
});
afterAll(async () => {
  setSmsProviderForTests(undefined);
  setEmailProviderForTests(undefined);
  delete process.env.EMAIL_PROVIDER;
  await close();
});

const allowance = async (userId: string, channel = "sms") =>
  (await db.query<{ granted: number; reserved: number; used: number }>(
    `select a.granted, a.reserved, a.used from plan_allowances a join user_plans p on p.id = a.user_plan_id
      where p.user_id = $1 and p.kind in ('paid','grant') and p.status = 'active' and a.channel = $2 order by p.ends_at limit 1`,
    [userId, channel],
  )).rows[0];

const makeDue = (renewalId: string) =>
  db.query("update reminder_jobs set due_at_utc = now() - interval '1 minute' where renewal_id = $1 and status = 'scheduled'", [renewalId]);

describe("Pro plan: availability, trial and purchase", () => {
  it("is off until an admin turns it on", async () => {
    const u = await createUser(db, "+9779841000901");
    await expect(startTrial(u, db)).rejects.toMatchObject({ code: "trial_unavailable" });
    await expect(buyPro(u, "k-off-123456", db)).rejects.toMatchObject({ code: "pro_unavailable" });
    expect((await getPlanState(u, db)).tier).toBe("basic");
    await setSetting({ id: admin }, "pro", PRO, db);
  });

  it("trial: Pro features once per account, no included messages", async () => {
    const u = await createUser(db, "+9779841000902");
    const st = await startTrial(u, db);
    expect(st).toMatchObject({ tier: "pro", kind: "trial", daysLeft: 7, allowances: [] });
    expect(await isPro(u, db)).toBe(true);
    await expect(startTrial(u, db)).rejects.toMatchObject({ code: "already_pro" });
    // Trial messages use credits as usual.
    await fund(db, u, 20);
    const { summary } = await createReminder(principalFor(u), { category: "other", label: "Trial item", calendar: "AD", expiryDate: inDays(20), offsets: [1440], ...base }, {}, db);
    expect(summary.scheduled).toBe(1);
    expect((await wallet(db, u)).reserved).toBe(3);
    // After the trial ends, it cannot be started again.
    await db.query("update user_plans set ends_at = now() - interval '1 second', starts_at = now() - interval '8 days' where user_id = $1", [u]);
    expect(await isPro(u, db)).toBe(false);
    await expect(startTrial(u, db)).rejects.toMatchObject({ code: "trial_used" });
  });

  it("buy: needs the full price in credits, debits once, ends the trial and moves scheduled SMS onto included messages", async () => {
    const u = await createUser(db, "+9779841000903");
    await startTrial(u, db);
    await fund(db, u, 30);
    const { reminder } = await createReminder(principalFor(u), { category: "other", label: "Before Pro", calendar: "AD", expiryDate: inDays(30), offsets: [7 * 1440, 1440], ...base }, {}, db);
    expect((await wallet(db, u)).reserved).toBe(6);
    await expect(buyPro(u, "k-buy-0000001", db)).rejects.toMatchObject({ status: 402, code: "insufficient_credits", detail: { shortfallCredits: 1000 - 24 } });
    await fund(db, u, 1000);
    const r = await buyPro(u, "k-buy-0000001", db);
    expect(r.replayed).toBe(false);
    expect(r.state).toMatchObject({ tier: "pro", kind: "paid" });
    const w = await wallet(db, u);
    expect(w.posted).toBe(30);
    expect(w.reserved).toBe(0); // the 2 SMS now use included messages
    expect(await allowance(u)).toMatchObject({ granted: 100, reserved: 2, used: 0 });
    const { rows: ledger } = await db.query<{ signed_credits: string }>("select signed_credits::text from wallet_ledger where user_id = $1 and type = 'plan'", [u]);
    expect(ledger.map((x) => Number(x.signed_credits))).toEqual([-1000]);
    // Same click again: no second charge.
    const again = await buyPro(u, "k-buy-0000001", db);
    expect(again.replayed).toBe(true);
    expect((await wallet(db, u)).posted).toBe(30);
    const { rows: trial } = await db.query<{ ended: boolean }>("select ends_at <= now() as ended from user_plans where user_id = $1 and kind = 'trial'", [u]);
    expect(trial[0].ended).toBe(true);
    // Sending uses the included message: no credit debit.
    await makeDue(reminder.id);
    expect((await runDispatcher(db, new Date())).submitted).toBe(2);
    expect(await allowance(u)).toMatchObject({ reserved: 0, used: 2 });
    expect((await wallet(db, u)).posted).toBe(30);
    const { rows: debits } = await db.query("select 1 from wallet_ledger where user_id = $1 and type = 'debit'", [u]);
    expect(debits).toHaveLength(0);
    const { rows: ev } = await db.query<{ kind: string; units: number }>("select kind, units from allowance_events where user_id = $1", [u]);
    expect(ev).toEqual([{ kind: "use", units: 1 }, { kind: "use", units: 1 }]);
  });

  it("buying again adds a year after the current one", async () => {
    const u = await createUser(db, "+9779841000904");
    await fund(db, u, 2000);
    const a = await buyPro(u, "k-year-000001", db);
    const b = await buyPro(u, "k-year-000002", db);
    expect(b.state.endsAt).toBe(a.state.endsAt); // the current year is unchanged
    expect(new Date(b.state.queuedUntil!).getTime() - new Date(a.state.endsAt!).getTime()).toBe(365 * 86_400_000);
  });
});

describe("Pro included messages in reminders", () => {
  let u: string;
  beforeAll(async () => {
    u = await createUser(db, "+9779841000910");
    await fund(db, u, 1050);
    await buyPro(u, "k-incl-00001", db);
  });

  it("preview marks included messages and charges only the rest", async () => {
    const p = await previewSchedule(principalFor(u), { label: "Preview", calendar: "AD", expiryDate: inDays(30), localTime: "09:00", offsets: [7 * 1440, 1440] }, db);
    expect(p.lines.every((l) => l.included && l.credits === 0)).toBe(true);
    expect(p.totalCredits).toBe(0);
    expect(p.byChannel.sms).toMatchObject({ messages: 2, included: 2, credits: 0 });
    expect(p.sufficient).toBe(true);
  });

  it("a message due after the plan ends uses credits", async () => {
    const before = await wallet(db, u);
    await createReminder(principalFor(u), { category: "passport", label: "Far away", calendar: "AD", expiryDate: inDays(500), offsets: [1440], ...base }, {}, db);
    expect((await wallet(db, u)).reserved).toBe(before.reserved + 3);
  });

  it("when included messages run out, credits are used; cancelling returns included messages", async () => {
    await db.query(
      "update plan_allowances a set granted = a.reserved + a.used + 1 from user_plans p where p.id = a.user_plan_id and p.user_id = $1 and a.channel = 'sms'",
      [u],
    );
    const before = await wallet(db, u);
    const { reminder } = await createReminder(principalFor(u), { category: "other", label: "Two msgs", calendar: "AD", expiryDate: inDays(40), offsets: [7 * 1440, 1440], ...base }, {}, db);
    expect((await wallet(db, u)).reserved).toBe(before.reserved + 3); // one included, one paid
    const a1 = await allowance(u);
    expect(a1.granted - a1.reserved - a1.used).toBe(0);
    await setReminderStatus(principalFor(u), reminder.id, "cancel", {}, db);
    const a2 = await allowance(u);
    expect(a2.reserved).toBe(a1.reserved - 1);
    expect((await wallet(db, u)).reserved).toBe(before.reserved);
  });

  it("a failed included message is given back", async () => {
    const v = await createUser(db, "+9779841000913");
    await fund(db, v, 1000);
    await buyPro(v, "k-fail-00001", db);
    const { reminder } = await createReminder(principalFor(v), { category: "other", label: "Fails", calendar: "AD", expiryDate: inDays(10), offsets: [1440], ...base }, {}, db);
    await makeDue(reminder.id);
    await runDispatcher(db, new Date());
    expect(await allowance(v)).toMatchObject({ used: 1 });
    const { rows } = await db.query<{ job_id: string; idempotency_key: string }>(
      "select a.job_id, a.idempotency_key from sms_attempts a join reminder_jobs j on j.id = a.job_id where j.renewal_id = $1",
      [reminder.id],
    );
    // Same key the reconciler uses when the provider reports a failure.
    const key = `debit:${rows[0].idempotency_key}`;
    await db.query("select wallet_reverse_debit_for_job($1, $2)", [rows[0].job_id, key]);
    await db.query("select wallet_reverse_debit_for_job($1, $2)", [rows[0].job_id, key]); // once only
    expect(await allowance(v)).toMatchObject({ used: 0 });
    expect((await wallet(db, v)).posted).toBe(0);
  });

  it("admin grant and revoke: revoked plan's messages fall back to credits", async () => {
    const w = await createUser(db, "+9779841000912");
    await fund(db, w, 10);
    await expect(grantPro({ id: admin }, w, { days: 0, withAllowances: true, note: "x" }, db)).rejects.toMatchObject({ code: "invalid_days" });
    const st = await grantPro({ id: admin }, w, { days: 30, withAllowances: true, note: "Launch partner" }, db);
    expect(st).toMatchObject({ tier: "pro", kind: "grant" });
    await createReminder(principalFor(w), { category: "other", label: "Granted", calendar: "AD", expiryDate: inDays(10), offsets: [1440], ...base }, {}, db);
    expect((await wallet(db, w)).reserved).toBe(0);
    await revokePlan({ id: admin }, st.planId!, "test", db);
    expect(await isPro(w, db)).toBe(false);
    expect((await wallet(db, w)).reserved).toBe(3);
    const { rows } = await db.query("select 1 from audit_events where action in ('plan.granted','plan.revoked') and json_detail_redacted::text like $1", [`%${st.planId}%`]);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("Pro email: verification, sign-in and email reminders", () => {
  let u: string;
  beforeAll(async () => {
    u = await createUser(db, "+9779841000920");
    await fund(db, u, 1000);
  });

  it("Basic accounts cannot add an email", async () => {
    await expect(requestEmailVerify(u, "ram@example.com", db)).rejects.toMatchObject({ code: "pro_required" });
  });

  it("verifies an email with a code; wrong codes count; codes are single-use", async () => {
    await buyPro(u, "k-mail-00001", db);
    const { devCode } = await requestEmailVerify(u, "Ram@Example.com", db);
    expect(devCode).toMatch(/^\d{6}$/);
    expect(mail.sent.at(-1)!.to).toBe("ram@example.com");
    await expect(confirmEmailVerify(u, "ram@example.com", "000000", db)).rejects.toMatchObject({ code: "invalid_code" });
    expect(await confirmEmailVerify(u, "ram@example.com", devCode!, db)).toEqual({ email: "ram@example.com", verified: true });
    await expect(confirmEmailVerify(u, "ram@example.com", devCode!, db)).rejects.toMatchObject({ code: "invalid_code" });
    // Another account cannot take the same address.
    const other = await createUser(db, "+9779841000921");
    await grantPro({ id: admin }, other, { days: 5, withAllowances: false, note: "test" }, db);
    await expect(requestEmailVerify(other, "ram@example.com", db)).rejects.toMatchObject({ code: "email_unavailable_for_account" });
  });

  it("signs in by email only for Pro accounts, and never reveals whether an email exists", async () => {
    const sentBefore = mail.sent.length;
    expect(await requestEmailLogin("nobody@example.com", db)).toEqual({});
    expect(mail.sent.length).toBe(sentBefore);
    const { devCode } = await requestEmailLogin("RAM@example.com", db);
    expect(devCode).toMatch(/^\d{6}$/);
    await expect(verifyEmailLogin("ram@example.com", "123", db)).rejects.toMatchObject({ status: 401 });
    expect(await verifyEmailLogin("ram@example.com", devCode!, db)).toBe(u);
    // After Pro ends, email sign-in stops (phone sign-in still works).
    await db.query("update user_plans set status = 'revoked' where user_id = $1", [u]);
    expect(await requestEmailLogin("ram@example.com", db)).toEqual({});
    await db.query("update user_plans set status = 'active' where user_id = $1", [u]);
  });

  it("five wrong codes lock that code", async () => {
    const { devCode } = await requestEmailLogin("ram@example.com", db);
    for (let i = 0; i < 5; i++) await expect(verifyEmailLogin("ram@example.com", "999999", db)).rejects.toMatchObject({ status: 401 });
    await expect(verifyEmailLogin("ram@example.com", devCode!, db)).rejects.toMatchObject({ status: 401 });
  });

  it("sends email reminders from the email allowance", async () => {
    const { reminder } = await createReminder(principalFor(u), { category: "domain", label: "nabikaran.org", calendar: "AD", expiryDate: inDays(15), offsets: [1440], channels: ["sms", "email"], ...base }, {}, db);
    expect(reminder.channels).toEqual(["sms", "email"]);
    await makeDue(reminder.id);
    const before = mail.sent.length;
    expect((await runDispatcher(db, new Date())).submitted).toBe(2);
    const e = mail.sent.slice(before);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ to: "ram@example.com", subject: "Reminder: nabikaran.org" });
    expect(e[0].html).toContain(`/renewals/${reminder.id}`);
    expect(await allowance(u, "email")).toMatchObject({ used: 1 });
    expect((await wallet(db, u)).posted).toBe(0);
  });

  it("refuses email reminders without Pro or a verified email", async () => {
    const b = await createUser(db, "+9779841000922");
    await fund(db, b, 50);
    await expect(createReminder(principalFor(b), { category: "other", label: "No", calendar: "AD", expiryDate: inDays(15), offsets: [1440], channels: ["email"], ...base }, {}, db))
      .rejects.toMatchObject({ code: "email_unavailable" });
    expect((await emailStatus(b, db)).verified).toBe(false);
  });

  it("Resend provider: sends the idempotency key, retries 5xx and never retries a 4xx", async () => {
    const calls: Array<{ headers: Record<string, string>; body: string }> = [];
    const replies = [new Response("{}", { status: 503 }), new Response(JSON.stringify({ id: "re_1" }), { status: 200 })];
    const fake = (async (_url: string, init: RequestInit) => {
      calls.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
      return replies.shift()!;
    }) as unknown as typeof fetch;
    const p = new ResendEmailProvider("re_test_key", "Nabikaran <reminders@nabikaran.org>", null, fake);
    expect(await p.send({ to: "a@b.co", subject: "s", text: "t", idempotencyKey: "email-123" })).toEqual({ kind: "accepted", providerMessageId: "re_1" });
    expect(calls).toHaveLength(2);
    expect(calls[0].headers["Idempotency-Key"]).toBe("email-123");
    expect(calls[0].headers.Authorization).toBe("Bearer re_test_key");
    const bad = new ResendEmailProvider("k", "f <f@x.org>", null, (async () => new Response(JSON.stringify({ name: "validation_error", message: "bad" }), { status: 422 })) as unknown as typeof fetch);
    expect(await bad.send({ to: "a@b.co", subject: "s", text: "t", idempotencyKey: "k" })).toMatchObject({ kind: "rejected", transient: false });
  });
});

describe("Pro subscription manager", () => {
  it("Basic accounts cannot save subscription details", async () => {
    const b = await createUser(db, "+9779841000930");
    await fund(db, b, 50);
    await expect(createReminder(principalFor(b), { category: "subscription", label: "Netflix", calendar: "AD", expiryDate: inDays(10), offsets: [1440], repeatMonths: 1, subscription: { amount: 15.49, currency: "USD", paymentMethod: "Card", autoRenew: true }, ...base }, {}, db))
      .rejects.toMatchObject({ status: 403, code: "pro_required" });
  });

  it("monthly subscription: a past charge date moves to the next one, totals per currency, and it rolls to next month", async () => {
    const u = await createUser(db, "+9779841000931");
    await fund(db, u, 1100);
    await buyPro(u, "k-subs-00001", db);
    const p = principalFor(u);
    const { reminder } = await createReminder(p, { category: "subscription", label: "Netflix", calendar: "AD", expiryDate: inDays(-40), offsets: [1440], repeatMonths: 1, subscription: { amount: 15.49, currency: "USD", paymentMethod: "Card ••1234", autoRenew: true }, ...base }, {}, db);
    expect(new Date(reminder.expiry.utc).getTime()).toBeGreaterThan(Date.now());
    expect(reminder.repeatMonths).toBe(1);
    expect(reminder.subscription).toEqual({ amount: 15.49, currency: "USD", paymentMethod: "Card ••1234", autoRenew: true });
    await createReminder(p, { category: "subscription", label: "WorldLink", calendar: "AD", expiryDate: inDays(20), offsets: [1440], repeatYearly: true, subscription: { amount: 12000, currency: "NPR", paymentMethod: "eSewa", autoRenew: false }, ...base }, {}, db);
    const view = await listSubscriptions(u, db);
    expect(view.items).toHaveLength(2);
    expect(view.totals).toEqual(expect.arrayContaining([{ currency: "NPR", monthly: 1000, yearly: 12000 }, { currency: "USD", monthly: 15.49, yearly: expect.closeTo(185.88, 2) }]));

    // Roll over: this month's date passed and its message finished.
    const raw = inDays(-1);
    await db.query("update reminder_jobs set status = 'delivered' where renewal_id = $1", [reminder.id]);
    await db.query("update renewal_items set expiry_at_utc = now() - interval '1 day', date_input_raw = $2 where id = $1", [reminder.id, raw]);
    const out = await rolloverYearly(db, new Date());
    expect(out.rolled).toBeGreaterThanOrEqual(1);
    const { rows } = await db.query<{ date_input_raw: string; cycle_no: number }>("select date_input_raw, cycle_no from renewal_items where id = $1", [reminder.id]);
    expect(rows[0].cycle_no).toBe(reminder.cycleNo + 1);
    expect(rows[0].date_input_raw > raw).toBe(true);
  });

  it("every-N-months keeps the day of month and clamps short months", () => {
    const after = new Date("2026-01-01T00:00:00Z");
    const a = nextEveryMonths("AD", "2026-01-31", "09:00", 1, new Date("2026-02-01T00:00:00Z"));
    expect(a!.raw).toBe("2026-02-28");
    const b = nextEveryMonths("AD", "2026-01-31", "09:00", 1, new Date("2026-03-01T00:00:00Z"));
    expect(b!.raw).toBe("2026-03-31"); // back to the 31st, not stuck on the 28th
    expect(nextEveryMonths("AD", "2025-11-15", "09:00", 3, after)!.raw).toBe("2026-02-15");
    expect(nextEveryMonths("BS", "2082-01-31", "09:00", 6, new Date("2025-05-01T00:00:00Z"))).not.toBeNull();
    expect(nextEveryMonths("AD", "2026-02-30", "09:00", 1, after)).toBeNull();
  });
});

describe("admin secrets", () => {
  it("stores a key write-only and audits without the value", async () => {
    expect(await secretStatus("resend_api_key", db)).toEqual({ set: false, last4: null, setAt: null });
    const st = await setSecret({ id: admin }, "resend_api_key", "re_live_abcdefgh1234", db);
    expect(st).toMatchObject({ set: true, last4: "1234" });
    expect(await getSecret("resend_api_key", db)).toBe("re_live_abcdefgh1234");
    const { rows } = await db.query<{ d: string }>("select json_detail_redacted::text as d from audit_events where action = 'secret.updated'");
    expect(rows[0].d).not.toContain("abcdefgh");
    await setSecret({ id: admin }, "resend_api_key", null, db);
    expect((await secretStatus("resend_api_key", db)).set).toBe(false);
  });

  it("email counts as set up only with the switch on, a From address and a key", async () => {
    delete process.env.EMAIL_PROVIDER;
    try {
      expect(await emailConfigured(db)).toBe(false);
      await setSetting({ id: admin }, "email", { enabled: true, from_name: "Nabikaran", from_email: "reminders@nabikaran.org", reply_to: "" }, db);
      expect(await emailConfigured(db)).toBe(false);
      await setSecret({ id: admin }, "resend_api_key", "re_live_key_5678", db);
      expect(await emailConfigured(db)).toBe(true);
      await setSetting({ id: admin }, "email", { enabled: false, from_name: "Nabikaran", from_email: "reminders@nabikaran.org", reply_to: "" }, db);
      expect(await emailConfigured(db)).toBe(false);
    } finally {
      process.env.EMAIL_PROVIDER = "mock";
    }
  });
});
