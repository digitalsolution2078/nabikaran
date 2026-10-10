import { getIntegrationOverrides, setIntegrationOverrides } from "@/lib/integrations";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, wallet, principalFor, inDays } from "./helpers/db";
import type { Db } from "@/lib/db";
import { MockSmsProvider } from "@/lib/providers/sms/mock";
import { setSmsProviderForTests } from "@/lib/providers/sms";
import { MockWhatsAppProvider } from "@/lib/providers/whatsapp/mock";
import { setWhatsAppProviderForTests } from "@/lib/providers/whatsapp";
import { setWhatsAppAvailableForTests } from "@/lib/whatsapp/availability";
import { createReminder, previewSchedule, getReminder } from "@/lib/core/reminders";
import { runDispatcher, runReconciler } from "@/lib/services/dispatcher";
import { processWebhook, verifySignature, verifySubscription } from "@/lib/whatsapp/webhook";
import { renderWhatsApp, validateWaTemplate } from "@/lib/whatsapp/templates";
import { MetaWhatsAppProvider } from "@/lib/providers/whatsapp/meta";

let db: Db;
let close: () => Promise<void> = async () => undefined;
const sms = new MockSmsProvider();
const wa = new MockWhatsAppProvider();
const base = { notes: null, familyMemberLabel: null, localTime: "09:00" } as const;
const SECRET = "test-app-secret";

const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
const statusBody = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { statuses: [{ id, status, timestamp: "1", recipient_id: "9779841000501", ...extra }] } }] }] });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  setSmsProviderForTests(sms);
  setWhatsAppProviderForTests(wa);
  setWhatsAppAvailableForTests(true);
  setIntegrationOverrides({ ...getIntegrationOverrides(), whatsappAppSecret: SECRET });
  setIntegrationOverrides({ ...getIntegrationOverrides(), whatsappVerifyToken: "verify-me" });
  await db.query("update app_settings set value = jsonb_set(jsonb_set(value, '{enabled}', 'true'), '{phone_number_id}', '\"1234567890\"') where key = 'whatsapp'");
});
afterAll(async () => {
  setSmsProviderForTests(undefined);
  setWhatsAppProviderForTests(undefined);
  setWhatsAppAvailableForTests(undefined);
  setIntegrationOverrides({ ...getIntegrationOverrides(), whatsappAppSecret: "" });
  setIntegrationOverrides({ ...getIntegrationOverrides(), whatsappVerifyToken: "" });
  await close();
});

async function dueNow(jobIds: string[]) {
  await db.query("update reminder_jobs set due_at_utc = now() - interval '1 minute' where id = any($1::uuid[])", [jobIds]);
}

describe("WhatsApp templates", () => {
  it("fills the approved template parameters and preview", () => {
    const r = renderWhatsApp({ label: "Bluebook\nBa 2 Pa", expiryAtUtc: new Date("2026-11-02T03:15:00Z"), dueAtUtc: new Date("2026-10-26T03:15:00Z"), locale: "en-NP" });
    expect(r.templateName).toBe("nabikaran_renewal_reminder");
    expect(r.params).toEqual(["Bluebook Ba 2 Pa", "7", "2026-11-02"]);
    expect(r.preview).toContain("expires in 7 day(s) on 2026-11-02");
    expect(validateWaTemplate({ meta_name: "Bad Name", meta_language: "en", body_preview: "{{1}} {{3}}", category: "today" })).toMatch(/lowercase/);
    expect(validateWaTemplate({ meta_name: "ok_name", meta_language: "en", body_preview: "{{1}} {{2}} {{3}}", category: "default" })).toBeNull();
  });
});

describe("WhatsApp scheduling and pricing", () => {
  it("previews SMS + WhatsApp with separate prices and a combined total", async () => {
    const uid = await createUser(db, "+9779841000501");
    const pv = await previewSchedule(principalFor(uid, "en-NP"), { label: "Bluebook", category: "bluebook", calendar: "AD", expiryDate: inDays(40), localTime: "09:00", offsets: [7 * 1440, 1440], channels: ["sms", "whatsapp"] }, db);
    expect(pv.lines).toHaveLength(4);
    expect(pv.byChannel.sms).toMatchObject({ messages: 2, credits: 6, creditsPerUnit: 3 });
    expect(pv.byChannel.whatsapp).toMatchObject({ messages: 2, credits: 6, creditsPerUnit: 3 });
    expect(pv.totalCredits).toBe(12);
    expect(pv.warnings).toContain("whatsapp_consent_required");
    expect(pv.lines.find((l) => l.channel === "whatsapp")!.whatsappTemplate!.name).toBe("nabikaran_renewal_reminder");
  });

  it("requires consent the first time, then reserves one job per channel", async () => {
    const uid = await createUser(db, "+9779841000502");
    await fund(db, uid, 50);
    const p = principalFor(uid, "en-NP");
    const input = { category: "bluebook" as const, label: "Bluebook", calendar: "AD" as const, expiryDate: inDays(40), offsets: [1440], channels: ["sms", "whatsapp"] as ("sms" | "whatsapp")[], ...base };
    await expect(createReminder(p, input, {}, db)).rejects.toMatchObject({ code: "whatsapp_consent_required" });
    const { reminder } = await createReminder(p, { ...input, whatsappConsent: true }, {}, db);
    expect(reminder.channels).toEqual(["sms", "whatsapp"]);
    expect(reminder.jobs.map((j) => j.channel).sort()).toEqual(["sms", "whatsapp"]);
    expect(await wallet(db, uid)).toEqual({ posted: 50, reserved: 6, available: 44 });
    const { rows } = await db.query("select 1 from users where id = $1 and whatsapp_opt_in_at is not null", [uid]);
    expect(rows).toHaveLength(1);
  });

  it("refuses WhatsApp when the owner has not enabled it", async () => {
    setWhatsAppAvailableForTests(false);
    const uid = await createUser(db, "+9779841000503");
    await fund(db, uid, 50);
    await expect(createReminder(principalFor(uid), { category: "other", label: "X", calendar: "AD", expiryDate: inDays(30), offsets: [0], channels: ["whatsapp"], whatsappConsent: true, ...base }, {}, db))
      .rejects.toMatchObject({ code: "whatsapp_unavailable" });
    setWhatsAppAvailableForTests(true);
  });

  it("WhatsApp has its own price: a change applies to new reminders only", async () => {
    const uid = await createUser(db, "+9779841000504");
    await fund(db, uid, 50);
    await db.query("update users set whatsapp_opt_in_at = now() where id = $1", [uid]);
    const p = principalFor(uid);
    const first = await createReminder(p, { category: "other", label: "A", calendar: "AD", expiryDate: inDays(30), offsets: [0], channels: ["whatsapp"], ...base }, {}, db);
    await db.query("insert into pricing_versions (credits_per_billable_unit, channel) values (5, 'whatsapp')");
    const second = await createReminder(p, { category: "other", label: "B", calendar: "AD", expiryDate: inDays(30), offsets: [0], channels: ["whatsapp"], ...base }, {}, db);
    expect(first.reminder.jobs[0].estimatedCredits).toBe(3);
    expect(second.reminder.jobs[0].estimatedCredits).toBe(5);
    const smsPv = await previewSchedule(p, { label: "S", calendar: "AD", expiryDate: inDays(30), localTime: "09:00", offsets: [0], channels: ["sms"] }, db);
    expect(smsPv.byChannel.sms!.creditsPerUnit).toBe(3);
    await db.query("insert into pricing_versions (credits_per_billable_unit, channel) values (3, 'whatsapp')"); // restore for later tests
  });
});

describe("WhatsApp delivery lifecycle", () => {
  async function scheduleOne(phone: string) {
    const uid = await createUser(db, phone);
    await fund(db, uid, 30);
    await db.query("update users set whatsapp_opt_in_at = now() where id = $1", [uid]);
    const { reminder } = await createReminder(principalFor(uid), { category: "other", label: "Policy", calendar: "AD", expiryDate: inDays(2), offsets: [0], channels: ["whatsapp"], ...base }, {}, db);
    await dueNow([reminder.jobs[0].id]);
    return { uid, reminderId: reminder.id, jobId: reminder.jobs[0].id };
  }
  const jobStatus = async (id: string) => (await db.query<{ status: string }>("select status from reminder_jobs where id = $1", [id])).rows[0].status;

  it("sends the approved template, charges once at the booked price, then tracks delivered and read", async () => {
    const { uid, jobId } = await scheduleOne("+9779841000505");
    const s = await runDispatcher(db, new Date());
    expect(s.submitted).toBe(1);
    const sent = wa.sent.at(-1)!;
    expect(sent).toMatchObject({ phoneNumberId: "1234567890", templateName: "nabikaran_renewal_reminder", language: "ne" }); // user locale ne-NP → Nepali template
    expect(sent.params[0]).toBe("Policy");
    expect(sent.params[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sent.idempotencyKey).toMatch(/^wa:/);
    expect(await wallet(db, uid)).toEqual({ posted: 27, reserved: 0, available: 27 });

    const read = statusBody(sent.id, "read");
    expect((await processWebhook(read, sign(read), db)).updated).toBe(1);
    expect(await jobStatus(jobId)).toBe("read");
    // A late "delivered" never downgrades "read".
    const delivered = statusBody(sent.id, "delivered");
    await processWebhook(delivered, sign(delivered), db);
    expect(await jobStatus(jobId)).toBe("read");
    const { rows } = await db.query<{ delivered_at: string | null; read_at: string | null }>("select delivered_at, read_at from sms_attempts where provider_message_id = $1", [sent.id]);
    expect(rows[0].delivered_at).not.toBeNull();
    expect(rows[0].read_at).not.toBeNull();
    const { rows: audits } = await db.query("select 1 from audit_events where action = 'whatsapp.message.read' and target_id = $1", [jobId]);
    expect(audits).toHaveLength(1);
  });

  it("a failed status after acceptance refunds the credits exactly once", async () => {
    const { uid, jobId } = await scheduleOne("+9779841000506");
    await runDispatcher(db, new Date());
    expect((await wallet(db, uid)).posted).toBe(27);
    const sent = wa.sent.at(-1)!;
    const failed = statusBody(sent.id, "failed", { errors: [{ code: 131026, title: "Message undeliverable" }] });
    const r = await processWebhook(failed, sign(failed), db);
    expect(r.refunded).toBe(1);
    expect(await jobStatus(jobId)).toBe("failed");
    expect(await wallet(db, uid)).toEqual({ posted: 30, reserved: 0, available: 30 });
    await processWebhook(failed, sign(failed), db); // replay
    expect((await wallet(db, uid)).posted).toBe(30);
  });

  it("rejects webhooks with a bad signature and changes nothing", async () => {
    const { jobId } = await scheduleOne("+9779841000507");
    await runDispatcher(db, new Date());
    const sent = wa.sent.at(-1)!;
    const body = statusBody(sent.id, "delivered");
    expect((await processWebhook(body, "sha256=" + "0".repeat(64), db)).ok).toBe(false);
    expect((await processWebhook(body, null, db)).ok).toBe(false);
    expect(await jobStatus(jobId)).toBe("submitted");
    const { rows } = await db.query("select 1 from whatsapp_webhook_events where signature_valid = false");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it("an unknown send outcome is resolved by the webhook (matched by our key) and charged once", async () => {
    const { uid, jobId } = await scheduleOne("+9779841000522");
    const s = await runDispatcher(db, new Date());
    expect(s.unknown).toBe(1);
    expect(await jobStatus(jobId)).toBe("unknown");
    const sent = wa.sent.at(-1)!;
    const body = statusBody(sent.id, "delivered", { biz_opaque_callback_data: sent.idempotencyKey });
    await processWebhook(body, sign(body), db);
    expect(await jobStatus(jobId)).toBe("delivered");
    expect(await wallet(db, uid)).toEqual({ posted: 27, reserved: 0, available: 27 });
    await processWebhook(body, sign(body), db);
    expect((await wallet(db, uid)).posted).toBe(27);
  });

  it("an unknown outcome with no webhook for 6 hours returns the credits", async () => {
    const { uid, jobId } = await scheduleOne("+9779841000622");
    await runDispatcher(db, new Date());
    expect(await jobStatus(jobId)).toBe("unknown");
    await runReconciler(db, new Date(Date.now() + 7 * 3600_000));
    expect(await jobStatus(jobId)).toBe("failed");
    expect(await wallet(db, uid)).toEqual({ posted: 30, reserved: 0, available: 30 });
  });

  it("a permanent rejection releases the reservation without charging", async () => {
    const { uid, jobId } = await scheduleOne("+9779841000600");
    await runDispatcher(db, new Date());
    expect(await jobStatus(jobId)).toBe("failed");
    expect(await wallet(db, uid)).toEqual({ posted: 30, reserved: 0, available: 30 });
  });

  it("disabling WhatsApp after scheduling fails the job and returns the credits", async () => {
    const { uid, jobId } = await scheduleOne("+9779841000508");
    setWhatsAppAvailableForTests(false);
    await runDispatcher(db, new Date());
    setWhatsAppAvailableForTests(true);
    expect(await jobStatus(jobId)).toBe("failed");
    expect(await wallet(db, uid)).toEqual({ posted: 30, reserved: 0, available: 30 });
  });

  it("STOP from the user opts them out", async () => {
    const uid = await createUser(db, "+9779841000509");
    await db.query("update users set whatsapp_opt_in_at = now() where id = $1", [uid]);
    const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: "9779841000509", type: "text", text: { body: "STOP" } }] } }] }] });
    expect((await processWebhook(body, sign(body), db)).optOuts).toBe(1);
    const { rows } = await db.query<{ at: string | null }>("select whatsapp_opt_in_at as at from users where id = $1", [uid]);
    expect(rows[0].at).toBeNull();
  });

  it("verifies the subscription handshake only with the right token", () => {
    expect(verifySubscription(new URLSearchParams("hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42"))).toBe("42");
    expect(verifySubscription(new URLSearchParams("hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42"))).toBeNull();
  });

  it("SMS + WhatsApp reminder detail shows one scheduled message per channel", async () => {
    const uid = await createUser(db, "+9779841000510");
    await fund(db, uid, 30);
    await db.query("update users set whatsapp_opt_in_at = now() where id = $1", [uid]);
    const { reminder } = await createReminder(principalFor(uid), { category: "other", label: "Both", calendar: "AD", expiryDate: inDays(20), offsets: [7 * 1440], channels: ["sms", "whatsapp"], ...base }, {}, db);
    const d = await getReminder(principalFor(uid), reminder.id, db);
    expect(d!.jobs.map((j) => `${j.channel}:${j.status}`).sort()).toEqual(["sms:scheduled", "whatsapp:scheduled"]);
  });
});

describe("Meta Cloud API client", () => {
  it("sends a template request and maps errors", async () => {
    const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
    const ok = new MetaWhatsAppProvider({
      accessToken: "TOKEN", apiVersion: "v21.0", graphBase: "https://graph.example",
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
        return new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const r = await ok.send({ to: "+9779841000511", phoneNumberId: "999", templateName: "t", language: "en", params: ["a", "1", "2026-01-01"], idempotencyKey: "wa:k" });
    expect(r).toMatchObject({ kind: "accepted", providerMessageId: "wamid.X" });
    expect(calls[0].url).toBe("https://graph.example/v21.0/999/messages");
    expect(calls[0].auth).toBe("Bearer TOKEN");
    expect(calls[0].body).toMatchObject({ to: "9779841000511", type: "template", template: { name: "t", language: { code: "en" } }, biz_opaque_callback_data: "wa:k" });

    const mk = (status: number, body: unknown) => new MetaWhatsAppProvider({ accessToken: "T", apiVersion: "v21.0", graphBase: "x", fetchImpl: (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch });
    expect(await mk(400, { error: { code: 132001, message: "Template does not exist" } }).send({ to: "+1", phoneNumberId: "1", templateName: "t", language: "en", params: [], idempotencyKey: "k" })).toMatchObject({ kind: "rejected", transient: false });
    expect(await mk(429, { error: { code: 130429, message: "rate" } }).send({ to: "+1", phoneNumberId: "1", templateName: "t", language: "en", params: [], idempotencyKey: "k" })).toMatchObject({ kind: "rejected", transient: true });
    expect(await mk(503, {}).send({ to: "+1", phoneNumberId: "1", templateName: "t", language: "en", params: [], idempotencyKey: "k" })).toMatchObject({ kind: "unknown" });
  });
});
