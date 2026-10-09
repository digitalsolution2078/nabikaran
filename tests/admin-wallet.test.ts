import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, wallet, principalFor, inDays } from "./helpers/db";
import type { Db } from "@/lib/db";
import { MockGateway } from "@/lib/payments/mock";
import { setPaymentGatewayForTests } from "@/lib/payments";
import { startManualTopup, submitManualTopup, approveManualTopup, rejectManualTopup, cancelManualTopup, listTopupsForAdmin, getReceipt, newPaymentReference } from "@/lib/services/manual-topups";
import { getSetting, setSetting, validateTopupAmount } from "@/lib/services/settings";
import { createCustomTopupOrder, confirmPaymentByRef } from "@/lib/services/payments";
import { directAdjustment, setUserRole, searchUsers, getUserDetail, getOverview, saveSmsTemplate, saveDocTemplate, listDocTemplates, listAudit } from "@/lib/services/admin-console";
import { can, isAdminRole } from "@/lib/auth/rbac";
import { createReminder, previewSchedule } from "@/lib/core/reminders";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let owner: string;
let admin: string;
let customer: string;
const gateway = new MockGateway("http://test.local");

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  owner = await createUser(db, "+9779851000001");
  admin = await createUser(db, "+9779851000002");
  customer = await createUser(db, "+9779851000003");
  setPaymentGatewayForTests(gateway);
});
afterAll(async () => {
  setPaymentGatewayForTests(undefined);
  await close();
});

describe("RBAC bootstrap and roles", () => {
  it("bootstrap_super_admin works once, then refuses", async () => {
    await expect(db.query("select bootstrap_super_admin('+9779800000000')")).rejects.toThrow(/sign in once/);
    const { rows } = await db.query<{ bootstrap_super_admin: string }>("select bootstrap_super_admin('+9779851000001')");
    expect(rows[0].bootstrap_super_admin).toBe(owner);
    await expect(db.query("select bootstrap_super_admin('+9779851000002')")).rejects.toThrow(/already exists/);
    const { rows: a } = await db.query("select 1 from audit_events where action = 'rbac.bootstrap_super_admin'");
    expect(a).toHaveLength(1);
  });

  it("role matrix: only super_admin manages roles, settings, SMS pricing and direct adjustments", () => {
    expect(isAdminRole("user")).toBe(false);
    expect(can("user", "admin.view")).toBe(false);
    expect(can("admin", "topups.decide")).toBe(true);
    expect(can("admin", "adjustments.direct")).toBe(false);
    expect(can("admin", "roles.manage")).toBe(false);
    expect(can("admin", "settings.manage")).toBe(false);
    expect(can("super_admin", "roles.manage")).toBe(true);
    expect(can("super_admin", "sms.manage")).toBe(true);
  });

  it("super admin promotes an admin; admins cannot change roles; last super admin cannot be demoted; no self-change", async () => {
    await setUserRole({ id: owner, role: "super_admin" }, admin, "admin", db);
    const { rows } = await db.query<{ role: string }>("select role from users where id = $1", [admin]);
    expect(rows[0].role).toBe("admin");
    await expect(setUserRole({ id: admin, role: "admin" }, customer, "admin", db)).rejects.toMatchObject({ status: 403 });
    await expect(setUserRole({ id: owner, role: "super_admin" }, owner, "user", db)).rejects.toMatchObject({ code: "self_role_change" });
    const other = await createUser(db, "+9779851000009");
    await setUserRole({ id: owner, role: "super_admin" }, other, "super_admin", db);
    await setUserRole({ id: other, role: "super_admin" }, owner, "user", db); // allowed: another super admin remains
    await expect(setUserRole({ id: owner, role: "user" }, other, "user", db)).rejects.toMatchObject({ status: 403 });
    await setUserRole({ id: other, role: "super_admin" }, owner, "super_admin", db);
    await setUserRole({ id: owner, role: "super_admin" }, other, "user", db);
    const { rows: sa } = await db.query<{ n: string }>("select count(*)::text as n from users where role = 'super_admin'");
    expect(sa[0].n).toBe("1");
  });
});

describe("settings and custom top-up amounts", () => {
  it("validates min/max and quick amounts; custom Khalti amount credits exactly once", async () => {
    await expect(validateTopupAmount(5, db)).rejects.toMatchObject({ code: "amount_too_small" });
    await expect(validateTopupAmount(20000, db)).rejects.toMatchObject({ code: "amount_too_large" });
    await expect(validateTopupAmount(10.5, db)).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(setSetting({ id: owner }, "topup", { min_npr: 100, max_npr: 50, quick_amounts: [60] }, db)).rejects.toMatchObject({ code: "invalid_setting" });
    await setSetting({ id: owner }, "topup", { min_npr: 10, max_npr: 5000, quick_amounts: [10, 100, 500] }, db);
    expect((await getSetting("topup", db)).min_npr).toBe(10);
    const order = await createCustomTopupOrder({ id: customer, phoneE164: "+9779851000003" }, 137, db);
    gateway.settle(order.gatewayRef, "completed", { amountPaisa: 13700 });
    const res = await Promise.all([1, 2, 3].map(() => confirmPaymentByRef("mock", order.gatewayRef, db)));
    expect(res.filter((r) => r.result === "credited")).toHaveLength(1);
    expect((await wallet(db, customer)).posted).toBe(137);
  });
});

describe("manual QR top-ups", () => {
  it("references are unambiguous and unique-looking", () => {
    const refs = new Set(Array.from({ length: 500 }, newPaymentReference));
    expect(refs.size).toBe(500);
    for (const r of refs) expect(r).toMatch(/^NB[2-9A-HJKMNP-Z]{6}$/);
  });

  it("start → submit → approve credits exactly once, even with concurrent approvals", async () => {
    const before = await wallet(db, customer);
    const { request, qr } = await startManualTopup(customer, 500, db);
    expect(qr.network).toBe("Fonepay");
    expect(request).toMatchObject({ status: "awaiting_payment", amountNpr: 500, credits: 500 });
    await expect(approveManualTopup(admin, request.id, "FP-123456", null, db)).rejects.toMatchObject({ code: "approve_refused" }); // not submitted yet
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const sub = await submitManualTopup(customer, request.id, { payerTxnRef: "TXN998877", receipt: { contentType: "image/png", bytes: png } }, db);
    expect(sub).toMatchObject({ status: "pending", hasReceipt: true });
    expect((await submitManualTopup(customer, request.id, { payerTxnRef: "TXN998877" }, db)).status).toBe("pending"); // idempotent resubmit
    expect((await getReceipt(request.id, db))?.bytes.equals(png)).toBe(true);
    const results = await Promise.all([1, 2, 3, 4].map(() => approveManualTopup(admin, request.id, "FP-BANK-0001", "matched in EBL statement", db)));
    expect(results.filter((r) => r.credited)).toHaveLength(1);
    expect((await wallet(db, customer)).posted).toBe(before.posted + 500);
    const { rows } = await db.query("select 1 from wallet_ledger where idempotency_key = $1", [`manual-topup:${request.id}`]);
    expect(rows).toHaveLength(1);
  });

  it("one bank reference cannot approve two requests; a bank reference is required; self-approval refused", async () => {
    const a = (await startManualTopup(customer, 100, db)).request;
    await submitManualTopup(customer, a.id, { payerTxnRef: "TXNAAA1" }, db);
    await expect(approveManualTopup(admin, a.id, "FP-BANK-0001", null, db)).rejects.toMatchObject({ code: "bank_ref_used" });
    await expect(approveManualTopup(admin, a.id, "  ", null, db)).rejects.toMatchObject({ code: "approve_refused" });
    const own = (await startManualTopup(admin, 100, db)).request;
    await submitManualTopup(admin, own.id, { payerTxnRef: "TXNSELF1" }, db);
    await expect(approveManualTopup(admin, own.id, "FP-SELF-1", null, db)).rejects.toMatchObject({ code: "approve_refused" });
    await expect(approveManualTopup(customer, a.id, "FP-BANK-0099", null, db)).rejects.toMatchObject({ code: "approve_refused" }); // not an admin
    expect((await approveManualTopup(owner, a.id, "FP-BANK-0002", null, db)).credited).toBe(true);
  });

  it("reject requires a reason and never credits; cancel only before payment; open-request cap", async () => {
    const before = await wallet(db, customer);
    const r = (await startManualTopup(customer, 50, db)).request;
    await submitManualTopup(customer, r.id, { payerTxnRef: "TXNREJ1" }, db);
    await expect(rejectManualTopup(admin, r.id, "", db)).rejects.toMatchObject({ code: "reject_refused" });
    expect((await rejectManualTopup(admin, r.id, "No matching credit in statement", db)).changed).toBe(true);
    await expect(approveManualTopup(admin, r.id, "FP-LATE-1", null, db)).rejects.toMatchObject({ code: "approve_refused" });
    expect((await wallet(db, customer)).posted).toBe(before.posted);
    const c = (await startManualTopup(customer, 50, db)).request;
    await cancelManualTopup(customer, c.id, db);
    await expect(cancelManualTopup(customer, c.id, db)).rejects.toMatchObject({ code: "invalid_state" });
    await startManualTopup(customer, 50, db);
    await startManualTopup(customer, 50, db);
    await startManualTopup(customer, 50, db);
    await expect(startManualTopup(customer, 50, db)).rejects.toMatchObject({ code: "too_many_open" });
    expect((await listTopupsForAdmin("rejected", db)).some((x) => x.id === r.id)).toBe(true);
  });

  it("another user cannot submit someone else's request; bad receipts rejected", async () => {
    const other = await createUser(db, "+9779851000010");
    const r = (await startManualTopup(other, 100, db)).request;
    await expect(submitManualTopup(customer, r.id, { payerTxnRef: "TXNX1234" }, db)).rejects.toMatchObject({ status: 404 });
    await expect(submitManualTopup(other, r.id, { payerTxnRef: "TXNX1234", receipt: { contentType: "text/html", bytes: Buffer.from("x") } }, db)).rejects.toMatchObject({ code: "invalid_receipt" });
  });
});

describe("direct adjustments", () => {
  it("super admin only, reason required, idempotent, never overdraws; admin cannot", async () => {
    const before = await wallet(db, customer);
    await expect(directAdjustment(admin, customer, 10, "goodwill credit", "k1", db)).rejects.toMatchObject({ code: "adjustment_refused" });
    await expect(directAdjustment(owner, customer, 10, "x", "k1", db)).rejects.toMatchObject({ code: "adjustment_refused" });
    const id1 = await directAdjustment(owner, customer, 25, "Compensation for failed SMS", "k-direct-1", db);
    const id2 = await directAdjustment(owner, customer, 25, "Compensation for failed SMS", "k-direct-1", db);
    expect(id2).toBe(id1);
    expect((await wallet(db, customer)).posted).toBe(before.posted + 25);
    await expect(directAdjustment(owner, customer, -1_000_000, "Clawback beyond balance", "k-direct-2", db)).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(directAdjustment(owner, customer, -99_999, "Clawback beyond balance", "k-direct-3", db)).rejects.toMatchObject({ code: "adjustment_refused" });
    await expect(directAdjustment(owner, owner, 10, "self credit attempt", "k-self", db)).rejects.toMatchObject({ code: "adjustment_refused" });
  });
});

describe("audit is immutable; admin views", () => {
  it("update/delete on audit_events is refused", async () => {
    await expect(db.query("update audit_events set action = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.query("delete from audit_events")).rejects.toThrow(/append-only/);
    expect((await listAudit({ action: "wallet." }, db)).length).toBeGreaterThan(0);
  });

  it("search by phone, partial phone and name; detail shows ledger and top-ups; overview totals", async () => {
    await db.query("update users set display_name = 'Sita Sharma' where id = $1", [customer]);
    expect((await searchUsers("9851000003", 10, db))[0]?.id).toBe(customer);
    expect((await searchUsers("sita", 10, db))[0]?.id).toBe(customer);
    expect((await searchUsers("1000003", 10, db))[0]?.id).toBe(customer);
    const d = await getUserDetail(customer, db);
    expect(d?.ledger.length).toBeGreaterThan(0);
    expect(d?.topups.length).toBeGreaterThan(0);
    const o = await getOverview(db);
    expect(o.credits.purchased).toBeGreaterThanOrEqual(737);
    expect(o.revenue.manualPaisa).toBeGreaterThanOrEqual(60000);
    expect(o.users.admins).toBeGreaterThanOrEqual(2);
  });
});

describe("SMS templates and single-segment reminders", () => {
  it("rejects Devanagari, extended chars and over-long templates; accepts a valid Roman one", async () => {
    await expect(saveSmsTemplate(owner, "ne-NP", "default", "Nabikaran: {label} को म्याद {days} दिन ({date})", db)).rejects.toMatchObject({ code: "invalid_template" });
    await expect(saveSmsTemplate(owner, "en-NP", "default", "Nabikaran: {label} [{days}] {date}", db)).rejects.toMatchObject({ code: "invalid_template" });
    await expect(saveSmsTemplate(owner, "en-NP", "default", "Nabikaran: {label} in {days} days on {date}. " + "x".repeat(120), db)).rejects.toMatchObject({ code: "invalid_template" });
    await expect(saveSmsTemplate(owner, "en-NP", "today", "Nabikaran: {label} today.", db)).rejects.toMatchObject({ code: "invalid_template" }); // missing {date}
    const ok = await saveSmsTemplate(owner, "ne-NP", "today", "Nabikaran: {label} ko myad aaja ({date}) sakinchha.", db);
    expect(ok.worstCaseSeptets).toBeLessThanOrEqual(160);
  });

  it("preview: every reminder is one GSM-7 segment; a Devanagari label is replaced by the category SMS name", async () => {
    const u = await createUser(db, "+9779851000011");
    await fund(db, u, 100);
    const p = principalFor(u, "ne-NP");
    const pv = await previewSchedule(p, { label: "मेरो ब्लुबुक", category: "bluebook", calendar: "AD", expiryDate: inDays(40), localTime: "09:00", offsets: [30 * 1440, 7 * 1440, 0] }, db);
    expect(pv.lines.every((l) => l.encoding === "GSM-7" && l.segments === 1)).toBe(true);
    expect(pv.lines[0].smsLabel).toBe("Bluebook");
    expect(pv.warnings).toContain("sms_label_adjusted");
    expect(pv.lines.every((l) => l.credits === pv.creditsPerUnit)).toBe(true);
    const long = await previewSchedule(principalFor(u, "en-NP"), { label: "Ba 2 Pa 1234 Bluebook of my father's old motorcycle", category: "bluebook", calendar: "AD", expiryDate: inDays(40), localTime: "09:00", offsets: [7 * 1440] }, db);
    expect(long.lines[0].segments).toBe(1);
    expect(long.lines[0].smsText.length).toBeLessThanOrEqual(160);
  });

  it("credit charge per SMS follows the admin price, not a hard-coded rupee", async () => {
    const u = await createUser(db, "+9779851000012");
    await fund(db, u, 100);
    await db.query("insert into pricing_versions (credits_per_billable_unit, effective_at) values (2, now())");
    const { reminder } = await createReminder(principalFor(u), { category: "domain", label: "nabikaran.org", calendar: "AD", expiryDate: inDays(30), localTime: "09:00", offsets: [7 * 1440, 1440], notes: null, familyMemberLabel: null, templateSlug: "domain" }, {}, db);
    expect(reminder.jobs.every((j) => j.estimatedCredits === 2 && j.estimatedSegments === 1)).toBe(true);
    expect((await wallet(db, u)).reserved).toBe(4);
    const { rows } = await db.query<{ template_slug: string }>("select template_slug from renewal_items where id = $1", [reminder.id]);
    expect(rows[0].template_slug).toBe("domain");
  });
});

describe("document templates", () => {
  it("seeded library covers the requested groups; admin edits are validated", async () => {
    const all = await listDocTemplates(false, db);
    const groups = new Set(all.map((t) => t.group_key));
    expect([...groups].sort()).toEqual(["business", "custom", "insurance", "personal", "vehicle"]);
    for (const slug of ["driving-licence", "bluebook", "vehicle-tax", "vehicle-insurance", "passport", "visa", "work-permit", "health-insurance", "tax-filing", "domain", "hosting", "custom"]) {
      expect(all.some((t) => t.slug === slug)).toBe(true);
    }
    expect(all.every((t) => /^[A-Za-z0-9 ./()&-]{1,30}$/.test(t.sms_label))).toBe(true);
    const t = all.find((x) => x.slug === "passport")!;
    await expect(saveDocTemplate(owner, { ...t, sms_label: "राहदानी" }, db)).rejects.toMatchObject({ code: "invalid_template" });
    await saveDocTemplate(owner, { ...t, popular: false }, db);
    expect((await listDocTemplates(false, db)).find((x) => x.slug === "passport")?.popular).toBe(false);
  });
});
