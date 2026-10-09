import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, wallet } from "./helpers/db";
import type { Db } from "@/lib/db";
import { MockSmsProvider } from "@/lib/providers/sms/mock";
import { setSmsProviderForTests } from "@/lib/providers/sms";
import { MockGateway } from "@/lib/payments/mock";
import { setPaymentGatewayForTests } from "@/lib/payments";
import { createRenewal, updateRenewal, previewSchedule, setRenewalStatus, getRenewal } from "@/lib/services/renewals";
import { runDispatcher, runReconciler } from "@/lib/services/dispatcher";
import { createTopupOrder, confirmPaymentByRef } from "@/lib/services/payments";
import { requestOtp, verifyOtp, OtpError } from "@/lib/auth/otp";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let userId: string;
const sms = new MockSmsProvider();
const gateway = new MockGateway("http://test.local");

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  userId = await createUser(db, "+9779841000099");
  setSmsProviderForTests(sms);
  setPaymentGatewayForTests(gateway);
});
afterAll(async () => {
  setSmsProviderForTests(undefined);
  setPaymentGatewayForTests(undefined);
  await close();
});

const now = new Date();
const inDays = (d: number) => {
  const x = new Date(now.getTime() + d * 86_400_000);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
};

describe("renewal lifecycle + wallet reservations", () => {
  it("preview shows exact projected charge per reminder", async () => {
    const p = await previewSchedule({ label: "Bluebook", calendar: "AD", expiryDate: inDays(40), localTime: "09:00", offsets: [30 * 1440, 7 * 1440, 0] }, "ne-NP", db, now);
    expect(p.lines).toHaveLength(3);
    expect(p.creditsPerUnit).toBe(3);
    expect(p.totalCredits).toBe(p.lines.reduce((s, l) => s + l.segments * 3, 0));
    expect(p.lines[0].body).toContain("Bluebook");
  });

  it("creating with insufficient credits marks jobs awaiting; top-up schedules them", async () => {
    const { summary, renewal } = await createRenewal(userId, "ne-NP", {
      category: "bluebook", label: "Bluebook", calendar: "AD", expiryDate: inDays(40), localTime: "09:00", offsets: [30 * 1440, 7 * 1440, 0], notes: null, familyMemberLabel: null,
    }, db, now);
    expect(summary.awaiting).toBe(3);
    expect(summary.scheduled).toBe(0);
    await fund(db, userId, 100);
    const { retryAwaitingCredits } = await import("@/lib/services/wallet");
    expect(await retryAwaitingCredits(userId, db)).toBe(3);
    const w = await wallet(db, userId);
    expect(w.reserved).toBeGreaterThan(0);
    const detail = await getRenewal(userId, renewal.id, db);
    expect(detail!.jobs.every((j) => j.status === "scheduled")).toBe(true);
  });

  it("editing starts a new cycle, cancels old jobs and releases holds", async () => {
    const { renewal } = await createRenewal(userId, "ne-NP", {
      category: "licence", label: "Licence", calendar: "AD", expiryDate: inDays(20), localTime: "09:00", offsets: [7 * 1440, 1440], notes: null, familyMemberLabel: null,
    }, db, now);
    const before = await wallet(db, userId);
    const { renewal: updated, summary } = await updateRenewal(userId, "ne-NP", renewal.id, {
      category: "licence", label: "Licence", calendar: "AD", expiryDate: inDays(25), localTime: "10:00", offsets: [1440], notes: null, familyMemberLabel: null,
    }, db, now);
    expect(updated.cycle_no).toBe(2);
    expect(summary.cancelled).toBe(2);
    expect(summary.scheduled).toBe(1);
    const after = await wallet(db, userId);
    expect(after.reserved).toBeLessThan(before.reserved);
    const { rows } = await db.query<{ status: string; cycle_no: number }>("select status, cycle_no from reminder_jobs where renewal_id = $1 order by cycle_no", [renewal.id]);
    expect(rows.filter((r) => r.cycle_no === 1).every((r) => r.status === "cancelled")).toBe(true);
  });

  it("BS date input persists canonical Gregorian/UTC", async () => {
    const { renewal } = await createRenewal(userId, "ne-NP", {
      category: "passport", label: "Passport", calendar: "BS", expiryDate: "2085-01-01", localTime: "09:00", offsets: [0], notes: null, familyMemberLabel: null,
    }, db, now);
    expect(renewal.date_input_calendar).toBe("BS");
    const { bsToAd } = await import("@/lib/bs-date");
    const { kathmanduToUtc } = await import("@/lib/time");
    const expected = kathmanduToUtc(bsToAd({ year: 2085, month: 1, day: 1 }), "09:00");
    expect(new Date(renewal.expiry_at_utc).toISOString()).toBe(expected.toISOString());
    expect(expected.toISOString()).toMatch(/^2028-04-1[34]T03:15:00.000Z$/);
  });

  it("pause releases holds; cancel after pause is clean", async () => {
    const { renewal } = await createRenewal(userId, "ne-NP", {
      category: "insurance", label: "Insurance", calendar: "AD", expiryDate: inDays(10), localTime: "09:00", offsets: [1440], notes: null, familyMemberLabel: null,
    }, db, now);
    const before = await wallet(db, userId);
    const hold = Number((await getRenewal(userId, renewal.id, db))!.jobs[0].estimated_credits);
    expect(hold).toBeGreaterThan(0);
    await setRenewalStatus(userId, renewal.id, "paused", db);
    expect((await wallet(db, userId)).reserved).toBe(before.reserved - hold);
    await setRenewalStatus(userId, renewal.id, "active", db);
    expect((await wallet(db, userId)).reserved).toBe(before.reserved);
    await setRenewalStatus(userId, renewal.id, "cancelled", db);
    expect((await wallet(db, userId)).reserved).toBe(before.reserved - hold);
  });
});

describe("dispatcher", () => {
  async function dueJob(phone: string, offsetMinutesAgo = 5) {
    const uid = await createUser(db, phone);
    await fund(db, uid, 30);
    const expiry = new Date(now.getTime() + 86_400_000);
    const { rows: r } = await db.query<{ id: string }>("insert into renewal_items (owner_user_id, category, label, expiry_at_utc) values ($1,'other','Thing',$2) returning id", [uid, expiry.toISOString()]);
    const { rows: rule } = await db.query<{ id: string }>("insert into reminder_rules (renewal_id, offset_minutes) values ($1, 1440) returning id", [r[0].id]);
    const due = new Date(now.getTime() - offsetMinutesAgo * 60_000);
    const { rows: job } = await db.query<{ id: string }>(
      "insert into reminder_jobs (renewal_id, rule_id, user_id, cycle_no, due_at_utc, estimated_segments, estimated_credits) values ($1,$2,$3,1,$4,2,6) returning id",
      [r[0].id, rule[0].id, uid, due.toISOString()],
    );
    await db.query("select wallet_reserve_for_job($1)", [job[0].id]);
    return { uid, jobId: job[0].id };
  }
  const status = async (id: string) => (await db.query<{ status: string }>("select status from reminder_jobs where id = $1", [id])).rows[0].status;

  it("accepted send charges actual units once; re-run does not resend", async () => {
    const { uid, jobId } = await dueJob("+9779841000101");
    const sentBefore = sms.sent.length;
    const s = await runDispatcher(db, new Date());
    expect(s.submitted).toBe(1);
    expect(await status(jobId)).toBe("submitted");
    const w = await wallet(db, uid);
    expect(w.reserved).toBe(0);
    expect(w.posted).toBeLessThan(30);
    const { rows: ledger } = await db.query<{ signed_credits: string }>("select signed_credits::text from wallet_ledger where user_id = $1 and type = 'debit'", [uid]);
    expect(ledger).toHaveLength(1);
    const s2 = await runDispatcher(db, new Date());
    expect(s2.claimed).toBe(0);
    expect(sms.sent.length).toBe(sentBefore + 1);
  });

  it("permanent rejection fails the job and releases the hold, no charge", async () => {
    const { uid, jobId } = await dueJob("+9779841000100");
    await runDispatcher(db, new Date());
    expect(await status(jobId)).toBe("failed");
    expect(await wallet(db, uid)).toEqual({ posted: 30, reserved: 0, available: 30 });
  });

  it("transient rejection schedules a backoff retry with hold kept", async () => {
    const { uid, jobId } = await dueJob("+9779841000111");
    const s = await runDispatcher(db, new Date());
    expect(s.retried).toBe(1);
    expect(await status(jobId)).toBe("scheduled");
    expect((await wallet(db, uid)).reserved).toBe(6);
    const { rows } = await db.query<{ next_attempt_at: string }>("select next_attempt_at from reminder_jobs where id = $1", [jobId]);
    expect(new Date(rows[0].next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    expect((await runDispatcher(db, new Date())).claimed).toBe(0); // not yet due for retry
  });

  it("unknown outcome is never blindly resent; reconciler finds it and charges once", async () => {
    const { uid, jobId } = await dueJob("+9779841000122");
    const sentBefore = sms.sent.length;
    const s = await runDispatcher(db, new Date());
    expect(s.unknown).toBe(1);
    expect(await status(jobId)).toBe("unknown");
    expect((await wallet(db, uid)).reserved).toBe(6); // hold kept
    await runDispatcher(db, new Date());
    expect(sms.sent.length).toBe(sentBefore + 1);
    const r = await runReconciler(db, new Date());
    expect(r.unknownResolved).toBe(1);
    expect(await status(jobId)).toBe("delivered");
    const w = await wallet(db, uid);
    expect(w.reserved).toBe(0);
    expect(w.posted).toBe(30 - 3); // provider reported 1 unit
    await runReconciler(db, new Date());
    expect((await wallet(db, uid)).posted).toBe(27);
  });

  it("renewal cancelled between claim and send is not sent", async () => {
    const { uid, jobId } = await dueJob("+9779841000133");
    await db.query("update renewal_items set status = 'cancelled' where id = (select renewal_id from reminder_jobs where id = $1)", [jobId]);
    const sentBefore = sms.sent.length;
    const s = await runDispatcher(db, new Date());
    expect(s.skipped).toBe(1);
    expect(sms.sent.length).toBe(sentBefore);
    expect(await status(jobId)).toBe("cancelled");
    expect((await wallet(db, uid)).reserved).toBe(0);
  });

  it("unverified phone is never messaged", async () => {
    const { jobId } = await dueJob("+9779841000144");
    await db.query("update users set phone_verified_at = null where id = (select user_id from reminder_jobs where id = $1)", [jobId]);
    await runDispatcher(db, new Date());
    expect(await status(jobId)).toBe("cancelled");
  });
});

describe("payments", () => {
  it("only server-verified Completed with matching amount credits, exactly once", async () => {
    const uid = await createUser(db, "+9779841000200");
    const order = await createTopupOrder({ id: uid, phoneE164: "+9779841000200" }, "NPR50", db);
    expect(order.paymentUrl).toContain("/pay/mock");
    // Pending: nothing
    expect((await confirmPaymentByRef("mock", order.gatewayRef, db)).result).toBe("not_completed");
    expect((await wallet(db, uid)).posted).toBe(0);
    // Completed with tampered amount: mismatch, no credit
    gateway.settle(order.gatewayRef, "completed", { amountPaisa: 100 });
    expect((await confirmPaymentByRef("mock", order.gatewayRef, db)).result).toBe("mismatch");
    expect((await wallet(db, uid)).posted).toBe(0);
    // Completed with correct amount: credited once even on replay/concurrency
    gateway.settle(order.gatewayRef, "completed", { amountPaisa: 5000 });
    const results = await Promise.all([1, 2, 3].map(() => confirmPaymentByRef("mock", order.gatewayRef, db)));
    expect(results.filter((r) => r.result === "credited")).toHaveLength(1);
    expect((await wallet(db, uid)).posted).toBe(50);
    const { rows } = await db.query<{ status: string }>("select status from payment_orders where id = $1", [order.orderId]);
    expect(rows[0].status).toBe("paid");
  });

  it("forged pidx and cancelled checkout never credit", async () => {
    const uid = await createUser(db, "+9779841000201");
    await expect(confirmPaymentByRef("mock", "forged", db)).rejects.toThrow(/Unknown payment reference/);
    const order = await createTopupOrder({ id: uid, phoneE164: "+9779841000201" }, "NPR20", db);
    gateway.settle(order.gatewayRef, "canceled");
    expect((await confirmPaymentByRef("mock", order.gatewayRef, db)).result).toBe("not_completed");
    const { rows } = await db.query<{ status: string }>("select status from payment_orders where id = $1", [order.orderId]);
    expect(rows[0].status).toBe("cancelled");
    expect((await wallet(db, uid)).posted).toBe(0);
  });

  it("unknown pack is rejected (client cannot set amount)", async () => {
    await expect(createTopupOrder({ id: userId, phoneE164: "+9779841000099" }, "NPR9999", db)).rejects.toThrow(/Unknown pack/);
  });
});

describe("OTP", () => {
  it("issues, verifies once, enforces attempts and rate limit", async () => {
    const phone = "9841000301";
    const r = await requestOtp({ phone, ip: "1.2.3.4" }, db);
    expect(r.phoneE164).toBe("+9779841000301");
    expect(r.devCode).toMatch(/^\d{6}$/);
    await expect(verifyOtp(phone, r.devCode === "000000" ? "000001" : "000000", db)).rejects.toThrow(/Incorrect/);
    const v = await verifyOtp(phone, r.devCode!, db);
    expect(v.isNew).toBe(true);
    await expect(verifyOtp(phone, r.devCode!, db)).rejects.toThrow(/No active code/);
    await requestOtp({ phone, ip: "1.2.3.4" }, db);
    await requestOtp({ phone, ip: "1.2.3.4" }, db);
    await expect(requestOtp({ phone, ip: "1.2.3.4" }, db)).rejects.toThrow(OtpError);
  });
  it("rejects invalid phones", async () => {
    await expect(requestOtp({ phone: "12345" }, db)).rejects.toThrow(/valid Nepal mobile/);
  });
});
