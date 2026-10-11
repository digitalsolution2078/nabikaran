import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser } from "./helpers/db";
import type { Db } from "@/lib/db";
import { setSetting } from "@/lib/services/settings";
import { grantPro, revokePlan, getPlanState } from "@/lib/services/plans";
import { buildIcs, disableCalendar, enableCalendar, feedForToken, getCalendarLink, googleTemplateLink, icsEscape, icsFold } from "@/lib/services/calendar";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let admin: string;
const PRO = { enabled: true, price_npr: 1000, duration_days: 365, trial_enabled: true, trial_days: 7, allowance_sms: 100, allowance_whatsapp: 100, allowance_email: 500 };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  admin = await createUser(db, "+9779841000950", "admin");
  await setSetting({ id: admin }, "pro", PRO, db);
});
afterAll(async () => close());

const tokenOf = (url: string | null) => (url ?? "").split("/").pop()!.replace(/\.ics$/, "");

async function item(uid: string, label: string, at: Date, extra: Record<string, unknown> = {}) {
  const { category = "other", ...rest } = extra;
  const cols = ["owner_user_id", "category", "label", "expiry_at_utc", ...Object.keys(rest)];
  const vals = [uid, category, label, at.toISOString(), ...Object.values(rest)];
  await db.query(`insert into renewal_items (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")})`, vals);
}

describe("Pro calendar feed", () => {
  it("is Pro only, and the link can be reset and turned off", async () => {
    const uid = await createUser(db, "+9779841000951");
    await expect(enableCalendar(uid, {}, db)).rejects.toMatchObject({ code: "pro_required" });
    await grantPro({ id: admin }, uid, { days: 30, withAllowances: false, note: "test" }, db);
    const a = await enableCalendar(uid, {}, db);
    expect(a.enabled).toBe(true);
    expect(a.url).toMatch(/\/api\/calendar\/[A-Za-z0-9_-]{32}\.ics$/);
    expect(a.webcal).toMatch(/^webcal:\/\//);
    expect(a.google).toContain("calendar.google.com/calendar/render?cid=webcal");
    // Turning on again keeps the same link; reset makes a new one and kills the old.
    expect((await enableCalendar(uid, {}, db)).url).toBe(a.url);
    const b = await enableCalendar(uid, { reset: true }, db);
    expect(b.url).not.toBe(a.url);
    expect(await feedForToken(tokenOf(a.url), db)).toBeNull();
    expect(await feedForToken(tokenOf(b.url), db)).toContain("BEGIN:VCALENDAR");
    await disableCalendar(uid, db);
    expect((await getCalendarLink(uid, db)).enabled).toBe(false);
    expect(await feedForToken(tokenOf(b.url), db)).toBeNull();
  });

  it("lists active reminders as all-day events in Nepal time, with repeat rules where safe", async () => {
    const uid = await createUser(db, "+9779841000952");
    await grantPro({ id: admin }, uid, { days: 30, withAllowances: false, note: "test" }, db);
    const link = await enableCalendar(uid, {}, db);
    const y = new Date().getUTCFullYear() + 1;
    // 20:00 UTC on the 14th is 01:45 on the 15th in Kathmandu: the event is on the 15th.
    await item(uid, "Netflix", new Date(`${y}-11-14T20:00:00Z`), { category: "subscription", sub_amount: 1499, sub_currency: "NPR", repeat_months: 1, sub_payment_method: "Card 1234" });
    await item(uid, "Bike bluebook", new Date(`${y}-12-01T03:15:00Z`), { repeat_yearly: true });
    await item(uid, "Paused one", new Date(`${y}-12-02T03:15:00Z`), { status: "paused" });
    await item(uid, "Old one", new Date(`${y - 3}-01-02T03:15:00Z`));
    await item(uid, "Rent; flat, 2", new Date(`${y}-12-31T03:15:00Z`), { repeat_months: 1 });
    const ics = (await feedForToken(tokenOf(link.url), db))!;
    expect(ics).toContain(`DTSTART;VALUE=DATE:${y}1115`);
    expect(ics).toContain(`DTEND;VALUE=DATE:${y}1116`);
    expect(ics).toContain("SUMMARY:Netflix · NPR 1\\,499");
    expect(ics).toContain("RRULE:FREQ=MONTHLY;INTERVAL=1");
    expect(ics).toContain("RRULE:FREQ=YEARLY");
    expect(ics).toContain("SUMMARY:Rent\\; flat\\, 2");
    expect(ics.match(/RRULE/g)).toHaveLength(2); // the 31st repeats via rollover, not RRULE
    expect(ics).not.toContain("Paused one");
    expect(ics).not.toContain("Old one");
    expect(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });

  it("is empty once Pro ends, so old events disappear", async () => {
    const uid = await createUser(db, "+9779841000953");
    await grantPro({ id: admin }, uid, { days: 30, withAllowances: false, note: "test" }, db);
    const link = await enableCalendar(uid, {}, db);
    await item(uid, "Insurance", new Date(Date.now() + 10 * 86_400_000));
    expect(await feedForToken(tokenOf(link.url), db)).toContain("Insurance");
    const st = await getPlanState(uid, db);
    await revokePlan({ id: admin }, st.planId!, "test", db);
    const ics = (await feedForToken(tokenOf(link.url), db))!;
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("rejects malformed tokens and escapes/folds text", async () => {
    expect(await feedForToken("../../etc", db)).toBeNull();
    expect(await feedForToken("x".repeat(32), db)).toBeNull();
    expect(icsEscape("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    const long = "SUMMARY:" + "नबिकरण ".repeat(20);
    const folded = icsFold(long);
    expect(folded.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect(folded.replace(/\r\n /g, "")).toBe(long);
    expect(buildIcs([])).toMatch(/^BEGIN:VCALENDAR\r\n[\s\S]*END:VCALENDAR\r\n$/);
    const g = googleTemplateLink({ label: "Bluebook", expiryUtc: "2026-11-14T20:00:00Z" });
    expect(g).toContain("action=TEMPLATE");
    expect(g).toContain("dates=20261115%2F20261116");
  });
});
