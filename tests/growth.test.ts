import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, wallet } from "./helpers/db";
import type { Db } from "@/lib/db";
import { MockSmsProvider } from "@/lib/providers/sms/mock";
import { setSmsProviderForTests } from "@/lib/providers/sms";
import { requestOtp, verifyOtp } from "@/lib/auth/otp";
import { attachReferral, getOrCreateReferralCode, rewardReferralIfQualified, referralSummary, referralReport } from "@/lib/services/referrals";
import { setSetting } from "@/lib/services/settings";
import { setPin, removePin, verifyPinLogin, pinProblem, pinStatus, PinError } from "@/lib/auth/pin";
import { csvCell, exportCustomersCsv } from "@/lib/services/customer-export";
import { can } from "@/lib/auth/rbac";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let owner: string;
const sms = new MockSmsProvider();

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  setSmsProviderForTests(sms);
  owner = await createUser(db, "+9779841000700", "admin");
  await db.query("update users set role = 'super_admin' where id = $1", [owner]);
});
afterAll(async () => {
  setSmsProviderForTests(undefined);
  await close();
});

const signUp = async (phone: string) => {
  const r = await requestOtp({ phone, ip: `10.0.0.${Math.floor(Math.random() * 250)}` }, db);
  return verifyOtp(phone, r.devCode!, db);
};

describe("referrals", () => {
  it("rewards both sides once, only after the new customer's paid top-ups reach the threshold", async () => {
    const alice = await createUser(db, "+9779841000701");
    const code = await getOrCreateReferralCode(alice, db);
    expect(code).toMatch(/^[A-Z2-9]{7}$/);
    expect(await getOrCreateReferralCode(alice, db)).toBe(code); // stable

    const bob = await signUp("9841000702");
    expect(bob.isNew).toBe(true);
    expect(await attachReferral(bob.userId, code.toLowerCase(), db)).toBe(true);
    expect(await attachReferral(bob.userId, code, db)).toBe(false); // only once

    expect(await rewardReferralIfQualified(bob.userId, db)).toBe(false); // no top-up yet
    await fund(db, bob.userId, 30);
    expect(await rewardReferralIfQualified(bob.userId, db)).toBe(false); // below NPR 50
    await fund(db, bob.userId, 30);
    const aBefore = (await wallet(db, alice)).posted;
    const bBefore = (await wallet(db, bob.userId)).posted;
    expect(await rewardReferralIfQualified(bob.userId, db)).toBe(true);
    expect(await rewardReferralIfQualified(bob.userId, db)).toBe(false); // paid once
    expect((await wallet(db, alice)).posted - aBefore).toBe(20);
    expect((await wallet(db, bob.userId)).posted - bBefore).toBe(10);
    const sum = await referralSummary(alice, db);
    expect(sum).toMatchObject({ invited: 1, rewarded: 1, creditsEarned: 20 });
    const { rows } = await db.query<{ type: string }>("select type from wallet_ledger where reference_type = 'referral_reward'");
    expect(rows.every((r) => r.type === "referral")).toBe(true);
  });

  it("refuses self-referral, unknown codes and existing customers' links when the programme is off", async () => {
    const carol = await createUser(db, "+9779841000703");
    const code = await getOrCreateReferralCode(carol, db);
    expect(await attachReferral(carol, code, db)).toBe(false);
    const dave = await createUser(db, "+9779841000704");
    expect(await attachReferral(dave, "NOPE999", db)).toBe(false);
    await setSetting({ id: owner }, "referral", { enabled: false, referrer_credits: 20, referee_credits: 10, min_topup_npr: 50, max_rewards_per_referrer: 25, message: "" }, db);
    expect(await attachReferral(dave, code, db)).toBe(false);
    await setSetting({ id: owner }, "referral", { enabled: true, referrer_credits: 20, referee_credits: 10, min_topup_npr: 50, max_rewards_per_referrer: 0, message: "" }, db);
  });

  it("over the inviter cap the new customer still gets the bonus, the inviter does not", async () => {
    const erin = await createUser(db, "+9779841000705");
    const code = await getOrCreateReferralCode(erin, db);
    const frank = await createUser(db, "+9779841000706");
    await attachReferral(frank, code, db);
    await fund(db, frank, 100);
    const before = (await wallet(db, erin)).posted;
    expect(await rewardReferralIfQualified(frank, db)).toBe(true);
    expect((await wallet(db, erin)).posted).toBe(before);
    const rep = await referralReport(db);
    expect(rep.totals.capped).toBe(1);
  });
});

describe("PIN sign-in", () => {
  it("rejects weak PINs", () => {
    for (const p of ["1111", "1234", "9876", "123456", "12a4", "123"]) expect(pinProblem(p)).toBeInstanceOf(PinError);
    expect(pinProblem("5555", null)?.code).toBe("weak_pin");
    expect(pinProblem("0707", "+9779841000707")?.code).toBe("weak_pin"); // end of phone number
    expect(pinProblem("4829")).toBeNull();
  });

  it("set, sign in without SMS or fee, lock after wrong tries, OTP unlocks", async () => {
    const g = await signUp("9841000708");
    const sentBefore = sms.sent.length;
    const feeBefore = (await wallet(db, g.userId)).posted;
    await setPin(g.userId, "4829", null, db);
    expect((await pinStatus(g.userId, db)).hasPin).toBe(true);
    const ok = await verifyPinLogin("9841000708", "4829", db);
    expect(ok.userId).toBe(g.userId);
    expect(sms.sent.length).toBe(sentBefore); // no SMS
    expect((await wallet(db, g.userId)).posted).toBe(feeBefore); // no fee
    const { rows } = await db.query<{ pin_hash: string }>("select pin_hash from users where id = $1", [g.userId]);
    expect(rows[0].pin_hash).not.toContain("4829");

    for (let i = 0; i < 4; i++) await expect(verifyPinLogin("9841000708", "1357", db)).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(verifyPinLogin("9841000708", "1357", db)).rejects.toMatchObject({ code: "pin_locked" });
    await expect(verifyPinLogin("9841000708", "4829", db)).rejects.toMatchObject({ code: "pin_locked" }); // even the right PIN
    await signUp("9841000708"); // OTP sign-in unlocks
    expect((await verifyPinLogin("9841000708", "4829", db)).userId).toBe(g.userId);
  });

  it("changing or removing needs the current PIN; unknown numbers look the same as wrong PINs; staff cannot use PINs", async () => {
    const h = await signUp("9841000709");
    await setPin(h.userId, "4829", null, db);
    await expect(setPin(h.userId, "5938", "0000", db)).rejects.toMatchObject({ code: "wrong_current_pin" });
    await setPin(h.userId, "5938", "4829", db);
    await expect(removePin(h.userId, "4829", db)).rejects.toMatchObject({ code: "wrong_current_pin" });
    await removePin(h.userId, "5938", db);
    await expect(verifyPinLogin("9841000709", "5938", db)).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(verifyPinLogin("9841099999", "5938", db)).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(setPin(owner, "4829", null, db)).rejects.toMatchObject({ code: "pin_not_for_staff" });
  });
});

describe("customer export", () => {
  it("only the super admin may export", () => {
    expect(can("super_admin", "customers.export")).toBe(true);
    for (const r of ["admin", "finance", "support", "content", "auditor", "user"]) expect(can(r, "customers.export")).toBe(false);
  });

  it("CSV has a header, one row per active customer, and neutralises formulas", async () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+9779841000701")).toBe("'+9779841000701");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    await db.query("update users set display_name = '=cmd|calc' where phone_e164 = '+9779841000701'");
    const { csv, rows } = await exportCustomersCsv({}, db);
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0].startsWith("user_id,phone,name")).toBe(true);
    expect(lines).toHaveLength(rows + 1);
    expect(csv).not.toContain("super_admin"); // staff excluded by default
    expect(csv).toContain("'=cmd|calc");
    expect((await exportCustomersCsv({ includeStaff: true, status: "all" }, db)).csv).toContain("super_admin");
  });
});
