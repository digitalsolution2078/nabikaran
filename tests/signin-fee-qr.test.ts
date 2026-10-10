import { getIntegrationOverrides, setIntegrationOverrides } from "@/lib/integrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, wallet, principalFor, inDays } from "./helpers/db";
import type { Db } from "@/lib/db";
import { MockSmsProvider } from "@/lib/providers/sms/mock";
import { setSmsProviderForTests } from "@/lib/providers/sms";
import { otpMessage, requestOtp, verifyOtp } from "@/lib/auth/otp";
import { estimateSegments } from "@/lib/sms/segments";
import { createReminder, previewSchedule, setReminderStatus } from "@/lib/core/reminders";
import { getLockState } from "@/lib/core/account-lock";
import { runDispatcher } from "@/lib/services/dispatcher";
import { approveManualTopup, checkGatewayTopup, startManualTopup, sweepGatewayTopups } from "@/lib/services/manual-topups";
import { cleanRemark, mockMarkPaid, sign } from "@/lib/providers/payments/fonepay";
import { setSetting } from "@/lib/services/settings";

let db: Db;
let close: () => Promise<void> = async () => undefined;
const sms = new MockSmsProvider();
const base = { notes: null, familyMemberLabel: null, localTime: "09:00" } as const;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  setSmsProviderForTests(sms);
});
afterAll(async () => {
  setSmsProviderForTests(undefined);
  setIntegrationOverrides({ ...getIntegrationOverrides(), fonepayMode: "off" });
  await close();
});

async function signIn(phone: string) {
  const r = await requestOtp({ phone, ip: `10.0.0.${Math.floor(Math.random() * 250)}` }, db);
  return verifyOtp(phone, r.devCode!, db);
}

describe("sign-in SMS", () => {
  it("is English-only GSM-7 and fits one SMS", () => {
    const text = otpMessage("123456");
    expect(text).toMatch(/^[\x20-\x7E]+$/);
    const est = estimateSegments(text);
    expect(est.encoding).toBe("GSM-7");
    expect(est.segments).toBe(1);
  });

  it("each successful sign-in costs 1 credit, taking the balance negative when empty", async () => {
    const first = await signIn("9841000901");
    expect(first.isNew).toBe(true);
    expect(first.feeCharged).toBe(1);
    expect(await wallet(db, first.userId)).toEqual({ posted: -1, reserved: 0, available: -1 });
    const sent = sms.sent.at(-1)!;
    expect(sent.text).toMatch(/^Nabikaran login code: \d{6}\./);
    const { rows } = await db.query<{ type: string; signed_credits: string; memo: string }>("select type, signed_credits::text, memo from wallet_ledger where user_id = $1", [first.userId]);
    expect(rows).toEqual([{ type: "fee", signed_credits: "-1", memo: "Sign-in SMS" }]);
  });

  it("a code that is requested but never verified charges nobody", async () => {
    const uid = await createUser(db, "+9779841000902");
    await requestOtp({ phone: "9841000902", ip: "10.1.1.1" }, db);
    expect(await wallet(db, uid)).toEqual({ posted: 0, reserved: 0, available: 0 });
  });

  it("staff are exempt unless charge_staff is enabled", async () => {
    const admin = await createUser(db, "+9779841000903", "admin");
    const r = await signIn("9841000903");
    expect(r.userId).toBe(admin);
    expect(r.feeCharged).toBe(0);
    expect((await wallet(db, admin)).posted).toBe(0);
  });

  it("locks usage below -5, still allows sign-in, and a top-up settles the debt first", async () => {
    const phone = "9841000904";
    let uid = "";
    for (let i = 0; i < 6; i++) {
      // Rate limits are per phone per 15 min; clear them between sign-ins for the test.
      await db.query("delete from phone_verifications where phone_e164 = '+9779841000904'");
      uid = (await signIn(phone)).userId;
    }
    expect((await wallet(db, uid)).available).toBe(-6);
    expect(await getLockState(uid, db)).toEqual({ locked: true, available: -6, minBalance: -5 });
    const p = principalFor(uid);
    await expect(createReminder(p, { category: "other", label: "X", calendar: "AD", expiryDate: inDays(30), offsets: [0], ...base }, {}, db))
      .rejects.toMatchObject({ status: 402, code: "account_locked" });

    // Top up 20 → balance 14 → unlocked, and a reminder can be created.
    await fund(db, uid, 20);
    expect(await getLockState(uid, db)).toMatchObject({ locked: false, available: 14 });
    const { summary } = await createReminder(p, { category: "other", label: "X", calendar: "AD", expiryDate: inDays(30), offsets: [0], ...base }, {}, db);
    expect(summary.scheduled).toBe(1);
  });

  it("exactly -5 is still allowed (lock is strictly below the floor)", async () => {
    const uid = await createUser(db, "+9779841000905");
    await db.query("select set_config('nabikaran.allow_debt','on',false)");
    await db.query("update wallets set posted_balance_credits = -5 where user_id = $1", [uid]);
    await db.query("select set_config('nabikaran.allow_debt','off',false)");
    expect((await getLockState(uid, db)).locked).toBe(false);
  });

  it("the debt guard rejects any other path that would push available below zero", async () => {
    const uid = await createUser(db, "+9779841000906");
    await expect(db.query("update wallets set posted_balance_credits = -1 where user_id = $1", [uid])).rejects.toThrow(/cannot go below zero/);
    // A fee taken while credits are reserved does not reduce what the reserved SMS is charged.
    await fund(db, uid, 3);
    const { reminder } = await createReminder(principalFor(uid), { category: "other", label: "Due", calendar: "AD", expiryDate: inDays(1), offsets: [0], ...base }, {}, db);
    expect(await wallet(db, uid)).toEqual({ posted: 3, reserved: 3, available: 0 });
    await db.query("select wallet_charge_signin_fee($1, gen_random_uuid(), 1)", [uid]);
    expect(await wallet(db, uid)).toEqual({ posted: 2, reserved: 3, available: -1 });
    const job = reminder.jobs[0].id;
    await db.query("update reminder_jobs set due_at_utc = now() - interval '1 minute' where id = $1", [job]);
    await runDispatcher(db, new Date());
    const { rows } = await db.query<{ signed_credits: string }>("select signed_credits::text from wallet_ledger where user_id = $1 and type = 'debit'", [uid]);
    expect(rows.map((r) => r.signed_credits)).toEqual(["-3"]);
    expect(await wallet(db, uid)).toEqual({ posted: -1, reserved: 0, available: -1 });
  });

  it("settings validation keeps the floor and fee in range", async () => {
    const admin = await createUser(db, "+9779841000907", "admin");
    await expect(setSetting({ id: admin }, "signin", { fee_credits: 1, min_balance: 5, charge_staff: false }, db)).rejects.toMatchObject({ code: "invalid_setting" });
    await setSetting({ id: admin }, "signin", { fee_credits: 1, min_balance: -5, charge_staff: false }, db);
  });
});

describe("shortfall includes sign-in debt", () => {
  it("with -1 available, a 12-credit reminder needs a 13-credit top-up", async () => {
    const uid = (await signIn("9841000917")).userId;
    const p = principalFor(uid);
    const input = { category: "other" as const, label: "Debt", calendar: "AD" as const, expiryDate: inDays(60), offsets: [30 * 1440, 7 * 1440, 1440, 0], ...base };
    const pv = await previewSchedule(p, input, db);
    expect(pv.reservedOnConfirmCredits).toBe(12);
    expect(pv.shortfallCredits).toBe(13);
    await expect(createReminder(p, input, {}, db)).rejects.toMatchObject({ detail: { neededCredits: 12, availableCredits: -1, shortfallCredits: 13 } });
    await fund(db, uid, 12);
    await expect(createReminder(p, input, {}, db)).rejects.toMatchObject({ detail: { shortfallCredits: 1 } });
    await fund(db, uid, 1);
    expect((await createReminder(p, input, {}, db)).summary.scheduled).toBe(4);
    expect(await wallet(db, uid)).toEqual({ posted: 12, reserved: 12, available: 0 });
  });
});

describe("SMS charge uses the price the job was reserved at", () => {
  it("a later price increase does not change what an already-scheduled SMS costs", async () => {
    const uid = await createUser(db, "+9779841000908");
    await fund(db, uid, 50);
    const { reminder } = await createReminder(principalFor(uid), { category: "other", label: "Booked", calendar: "AD", expiryDate: inDays(1), offsets: [0], ...base }, {}, db);
    expect((await wallet(db, uid)).reserved).toBe(3);
    await db.query("insert into pricing_versions (credits_per_billable_unit) values (5)");
    await db.query("update reminder_jobs set due_at_utc = now() - interval '1 minute' where id = $1", [reminder.jobs[0].id]);
    await runDispatcher(db, new Date());
    const { rows } = await db.query<{ signed_credits: string }>("select signed_credits::text from wallet_ledger where user_id = $1 and type = 'debit'", [uid]);
    expect(rows.map((r) => r.signed_credits)).toEqual(["-3"]);
    expect(await wallet(db, uid)).toEqual({ posted: 47, reserved: 0, available: 47 });
    await db.query("delete from pricing_versions where credits_per_billable_unit = 5");
  });
});

describe("Fonepay dynamic QR", () => {
  it("signs requests as HMAC-SHA512 over the comma-joined fields", () => {
    // Reference value computed independently (Python hmac/sha512).
    expect(sign("secret", ["100", "NB123", "M1", "a", "b"])).toBe("75c8b89327ffdd1e9ddf34f75bec3e3b56e9031ab0c9dec825002c16db08f259e7d46bf03bf7f9024f6942c5e073bffe66fc47df66259843757838d9a5e9f355");
    expect(cleanRemark("NB7K <script>& Topup!!")).toBe("NB7K script Topup");
  });

  it("creates a dynamic QR, confirms automatically once paid, exactly once", async () => {
    setIntegrationOverrides({ ...getIntegrationOverrides(), fonepayMode: "mock" });
    const uid = await createUser(db, "+9779841000909");
    const { request } = await startManualTopup(uid, 150, db);
    expect(request.qrMode).toBe("dynamic");
    expect(request.qrPayload).toContain(request.reference);
    expect(request.qrPayload).toContain("|150|");

    // Not paid yet → stays awaiting.
    expect((await checkGatewayTopup(request.id, uid, db)).status).toBe("awaiting_payment");
    // Another user cannot poll it.
    const other = await createUser(db, "+9779841000910");
    await expect(checkGatewayTopup(request.id, other, db)).rejects.toMatchObject({ code: "not_found" });

    mockMarkPaid(request.reference, "TRACE123");
    await db.query("update manual_topup_requests set gateway_checked_at = null where id = $1", [request.id]);
    const done = await checkGatewayTopup(request.id, uid, db);
    expect(done.status).toBe("approved");
    expect(await wallet(db, uid)).toEqual({ posted: 150, reserved: 0, available: 150 });

    // Replays from the sweep or a late admin approval never credit twice.
    expect((await sweepGatewayTopups(db)).credited).toBe(0);
    const { rows: c } = await db.query<{ confirm_gateway_topup: boolean }>("select confirm_gateway_topup($1, 'TRACE123')", [request.id]);
    expect(c[0].confirm_gateway_topup).toBe(false);
    const admin = await createUser(db, "+9779841000912", "admin");
    expect(await approveManualTopup(admin, request.id, "BANKREF999", null, db)).toEqual({ credited: false });
    expect((await wallet(db, uid)).posted).toBe(150);
  });

  it("the background sweep confirms payments whose page was closed", async () => {
    setIntegrationOverrides({ ...getIntegrationOverrides(), fonepayMode: "mock" });
    const uid = await createUser(db, "+9779841000913");
    const { request } = await startManualTopup(uid, 60, db);
    mockMarkPaid(request.reference, "TRACE-SWEEP");
    const r = await sweepGatewayTopups(db);
    expect(r.credited).toBe(1);
    expect((await wallet(db, uid)).posted).toBe(60);
  });

  it("a top-up after sign-in debt settles the debt first", async () => {
    setIntegrationOverrides({ ...getIntegrationOverrides(), fonepayMode: "mock" });
    const uid = (await signIn("9841000914")).userId;
    expect((await wallet(db, uid)).posted).toBe(-1);
    const { request } = await startManualTopup(uid, 50, db);
    mockMarkPaid(request.reference, "TRACE-DEBT");
    await checkGatewayTopup(request.id, uid, db);
    expect((await wallet(db, uid)).posted).toBe(49);
  });

  it("falls back to the static QR when the gateway is off", async () => {
    setIntegrationOverrides({ ...getIntegrationOverrides(), fonepayMode: "off" });
    const uid = await createUser(db, "+9779841000915");
    const { request } = await startManualTopup(uid, 40, db);
    expect(request.qrMode).toBe("static");
    expect(request.qrPayload).toBeNull();
  });

  it("resume is refused when the wallet cannot fund every paused SMS", async () => {
    const uid = await createUser(db, "+9779841000916");
    await fund(db, uid, 6);
    const p = principalFor(uid);
    const { reminder } = await createReminder(p, { category: "other", label: "Pause", calendar: "AD", expiryDate: inDays(40), offsets: [1440, 2880], ...base }, {}, db);
    await setReminderStatus(p, reminder.id, "pause", {}, db);
    // Pausing released 6; another reminder now holds 3, so only 3 remain for the 6 needed.
    await createReminder(p, { category: "other", label: "Other", calendar: "AD", expiryDate: inDays(40), offsets: [1440], ...base }, {}, db);
    await expect(setReminderStatus(p, reminder.id, "resume", {}, db)).rejects.toMatchObject({ code: "insufficient_credits" });
    const { rows } = await db.query<{ status: string }>("select status from renewal_items where id = $1", [reminder.id]);
    expect(rows[0].status).toBe("paused");
  });
});
