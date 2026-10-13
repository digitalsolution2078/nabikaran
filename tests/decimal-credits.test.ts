import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, wallet, principalFor, inDays } from "./helpers/db";
import type { Db } from "@/lib/db";
import { MockSmsProvider } from "@/lib/providers/sms/mock";
import { setSmsProviderForTests } from "@/lib/providers/sms";
import { createReminder, previewSchedule } from "@/lib/core/reminders";
import { getActivePricing, roundCredits } from "@/lib/core/wallet";
import { runDispatcher } from "@/lib/services/dispatcher";
import { approveManualTopup, startManualTopup, submitManualTopup } from "@/lib/services/manual-topups";
import { counterTopup } from "@/lib/services/counter";
import { createPricingVersion } from "@/lib/services/admin";
import { listBonusTiers, saveBonusTiers, usageByChannel } from "@/lib/services/pricing";
import { bonusFor, nextTier } from "@/lib/bonus";
import { createPendingGiftCode } from "@/lib/services/credit-codes";

let db: Db;
let close: () => Promise<void> = async () => undefined;
const sms = new MockSmsProvider();
const base = { notes: null, familyMemberLabel: null, localTime: "09:00" } as const;

beforeAll(async () => {
  ({ db, close } = await createTestDb({ decimalPricing: true, topupBonus: true }));
  setSmsProviderForTests(sms);
});
afterAll(async () => {
  setSmsProviderForTests(undefined);
  await close();
});

const ledger = async (uid: string) =>
  (await db.query<{ type: string; c: string }>("select type, signed_credits::text as c from wallet_ledger where user_id = $1 order by id", [uid])).rows.map((r) => `${r.type}:${r.c}`);

describe("decimal credits (1 credit = NPR 1, two decimals)", () => {
  it("defaults: SMS 1.50, WhatsApp 1.00, email 0.30 per message", async () => {
    expect((await getActivePricing(db, "sms")).creditsPerUnit).toBe(1.5);
    expect((await getActivePricing(db, "whatsapp")).creditsPerUnit).toBe(1);
    expect((await getActivePricing(db, "email")).creditsPerUnit).toBe(0.3);
  });

  it("no wallet function keeps a whole-number (bigint) credit argument", async () => {
    const { rows } = await db.query("select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and pg_get_function_identity_arguments(p.oid) ~* 'bigint'");
    expect(rows).toEqual([]);
    const { rows: cols } = await db.query<{ data_type: string }>("select data_type from information_schema.columns where table_name = 'wallets' and column_name = 'posted_balance_credits'");
    expect(cols[0].data_type).toBe("numeric");
  });

  it("reserves and charges 1.50 per SMS exactly, leaving a fractional balance", async () => {
    const uid = await createUser(db, "+9779841002001");
    await fund(db, uid, 10);
    const p = principalFor(uid);
    const pv = await previewSchedule(p, { label: "Bluebook", calendar: "AD", expiryDate: inDays(30), localTime: "09:00", offsets: [7 * 1440, 1440, 0] }, db);
    expect(pv.lines.every((l) => l.credits === 1.5 * l.segments)).toBe(true);
    expect(pv.totalCredits).toBe(4.5);
    const { reminder } = await createReminder(p, { category: "bluebook", label: "Bluebook", calendar: "AD", expiryDate: inDays(30), offsets: [7 * 1440, 1440, 0], ...base }, {}, db);
    expect(await wallet(db, uid)).toEqual({ posted: 10, reserved: 4.5, available: 5.5 });
    await db.query("update reminder_jobs set due_at_utc = now() - interval '1 minute' where id = $1", [reminder.jobs[0].id]);
    await runDispatcher(db, new Date());
    expect(await wallet(db, uid)).toEqual({ posted: 8.5, reserved: 3, available: 5.5 });
    expect((await ledger(uid)).at(-1)).toBe("debit:-1.50");
    const usage = await usageByChannel(uid, db);
    expect(usage.allTime.find((u) => u.channel === "sms")).toEqual({ channel: "sms", messages: 1, credits: 1.5 });
  });

  it("asks for a whole-rupee top-up when short by a fraction", async () => {
    const uid = await createUser(db, "+9779841002002");
    await fund(db, uid, 1);
    await expect(createReminder(principalFor(uid), { category: "other", label: "Tax", calendar: "AD", expiryDate: inDays(20), offsets: [1440], ...base }, {}, db))
      .rejects.toMatchObject({ code: "insufficient_credits", detail: { neededCredits: 1.5, availableCredits: 1, shortfallCredits: 1 } });
  });

  it("admin can set a two-decimal price; three decimals are refused", async () => {
    const admin = await createUser(db, "+9779841002003", "admin");
    await createPricingVersion(admin, 0.25, new Date(), db, "email");
    expect((await getActivePricing(db, "email")).creditsPerUnit).toBe(0.25);
    await expect(createPricingVersion(admin, 0.255, new Date(), db, "email")).rejects.toMatchObject({ code: "invalid_price" });
    await createPricingVersion(admin, 0.3, new Date(), db, "email");
  });

  it("rounds JS sums to two decimals", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(roundCredits(0.1 + 0.2)).toBe(0.3);
    expect(roundCredits(0.3 * 3)).toBe(0.9);
  });
});

describe("top-up bonus tiers", () => {
  it("default tiers 3/5/8/10% and the shared calculator", async () => {
    const tiers = await listBonusTiers(db);
    expect(tiers).toEqual([{ minNpr: 500, percent: 3 }, { minNpr: 1000, percent: 5 }, { minNpr: 2500, percent: 8 }, { minNpr: 5000, percent: 10 }]);
    expect(bonusFor(499, tiers)).toBe(0);
    expect(bonusFor(500, tiers)).toBe(15);
    expect(bonusFor(999, tiers)).toBe(29.97);
    expect(bonusFor(1000, tiers)).toBe(50);
    expect(bonusFor(7000, tiers)).toBe(700);
    expect(nextTier(800, tiers)).toEqual({ minNpr: 1000, percent: 5 });
    expect(nextTier(9000, tiers)).toBeNull();
    const { rows } = await db.query<{ b: string }>("select topup_bonus_credits(999)::text as b");
    expect(rows[0].b).toBe("29.97");
  });

  it("QR top-up posts the top-up and its bonus as separate ledger lines, once", async () => {
    const uid = await createUser(db, "+9779841002004");
    const finance = await createUser(db, "+9779841002005");
    await db.query("update users set role = 'finance' where id = $1", [finance]);
    const { request } = await startManualTopup(uid, 1000, db);
    expect(request.bonusCredits).toBe(50);
    await submitManualTopup(uid, request.id, { payerTxnRef: "TXN-BONUS-1" }, db);
    expect(await approveManualTopup(finance, request.id, "BANK-BONUS-1", null, db)).toEqual({ credited: true });
    expect(await approveManualTopup(finance, request.id, "BANK-BONUS-1", null, db)).toEqual({ credited: false });
    expect(await ledger(uid)).toEqual(["topup:1000.00", "bonus:50.00"]);
    expect((await wallet(db, uid)).available).toBe(1050);
  });

  it("counter top-ups get the bonus too; gift cards never do", async () => {
    const cust = await createUser(db, "+9779841002006");
    const staff = await createUser(db, "+9779841002007");
    await db.query("update users set role = 'counter' where id = $1", [staff]);
    const r = await counterTopup({ id: staff }, { phone: "9841002006", amountNpr: 2500, method: "cash", idempotencyKey: "ctr-bonus-1" }, db);
    expect(r.bonus).toBe(200);
    expect(r.credits).toBe(2700);
    expect(await ledger(cust)).toEqual(["topup:2500.00", "bonus:200.00"]);
    const gift = await createPendingGiftCode({ credits: 5000, fromUserId: cust, createdBy: cust }, db);
    const { rows } = await db.query("insert into manual_topup_requests (user_id, reference, amount_paisa, credits, purpose, gift_code_id) values ($1, 'GIFTX1', 500000, 5000, 'gift', $2) returning bonus_credits::text as b", [cust, gift.id]);
    expect(rows[0]).toEqual({ b: "0.00" });
  });

  it("admin edits tiers; bigger tiers must give bigger bonuses; empty turns it off", async () => {
    const admin = await createUser(db, "+9779841002008", "admin");
    await expect(saveBonusTiers(admin, [{ minNpr: 500, percent: 5 }, { minNpr: 1000, percent: 3 }], db)).rejects.toMatchObject({ code: "tier_order" });
    await expect(saveBonusTiers(admin, [{ minNpr: 500, percent: 5 }, { minNpr: 500, percent: 6 }], db)).rejects.toMatchObject({ code: "duplicate_tier" });
    await saveBonusTiers(admin, [], db);
    const { rows } = await db.query<{ b: string }>("select topup_bonus_credits(5000)::text as b");
    expect(rows[0].b).toBe("0");
    await saveBonusTiers(admin, [{ minNpr: 500, percent: 3 }, { minNpr: 1000, percent: 5 }, { minNpr: 2500, percent: 8 }, { minNpr: 5000, percent: 10 }], db);
  });
});
