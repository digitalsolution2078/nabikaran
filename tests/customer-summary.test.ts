import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, principalFor, inDays } from "./helpers/db";
import type { Db } from "@/lib/db";
import { createReminder, setReminderStatus } from "@/lib/core/reminders";
import { getCustomerSummary, listRenewalsForUser, listCustomerMessages } from "@/lib/services/customer-summary";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let uid: string;
const base = { notes: null, familyMemberLabel: null, localTime: "09:00" } as const;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  uid = await createUser(db, "+9779841000901");
  await fund(db, uid, 200);
  const p = principalFor(uid);
  await createReminder(p, { category: "bluebook", label: "Bluebook Ba 2", calendar: "AD", expiryDate: inDays(10), offsets: [7 * 1440, 1440], ...base }, {}, db);
  await createReminder(p, { category: "passport", label: "Passport Ram", calendar: "AD", expiryDate: inDays(200), offsets: [30 * 1440], ...base, familyMemberLabel: "Ram" }, {}, db);
  const { reminder } = await createReminder(p, { category: "domain", label: "example.com.np 100%_off", calendar: "AD", expiryDate: inDays(60), offsets: [1440], ...base }, {}, db);
  await setReminderStatus(p, reminder.id, "pause", {}, db);
  // An expired document (expiry moved into the past after creation).
  const { reminder: old } = await createReminder(p, { category: "other", label: "Old permit", calendar: "AD", expiryDate: inDays(5), offsets: [1440], ...base }, {}, db);
  await db.query("update renewal_items set expiry_at_utc = now() - interval '3 days' where id = $1", [old.id]);
});
afterAll(async () => close());

describe("customer dashboard summary", () => {
  it("counts expired, due soon, scheduled and awaiting; returns ISO strings only", async () => {
    const s = await getCustomerSummary(uid, db);
    expect(s.counts).toMatchObject({ active: 3, paused: 1, expired: 1, dueSoon: 1, awaitingCredits: 0 });
    expect(s.counts.upcomingMessages).toBeGreaterThanOrEqual(3);
    expect(s.next).not.toBeNull();
    expect(typeof s.next!.dueAt).toBe("string");
    expect(s.expiringSoon.every((r) => typeof r.expiryAt === "string")).toBe(true);
    expect(s.wallet.available).toBe(200 - s.wallet.reserved);
  });

  it("works for a brand-new user with nothing yet", async () => {
    const fresh = await createUser(db, "+9779841000902");
    const s = await getCustomerSummary(fresh, db);
    expect(s.counts).toEqual({ active: 0, paused: 0, expired: 0, dueSoon: 0, upcomingMessages: 0, awaitingCredits: 0 });
    expect(s.next).toBeNull();
    expect(await listCustomerMessages(fresh, "pending", db)).toEqual([]);
  });
});

describe("renewals filters and search", () => {
  const labels = async (opts: Parameters<typeof listRenewalsForUser>[1]) => (await listRenewalsForUser(uid, opts, db)).map((r) => r.label).sort();
  it("filters", async () => {
    expect(await labels({ filter: "active" })).toEqual(["Bluebook Ba 2", "Passport Ram"]);
    expect(await labels({ filter: "expired" })).toEqual(["Old permit"]);
    expect(await labels({ filter: "due" })).toEqual(["Bluebook Ba 2"]);
    expect(await labels({ filter: "paused" })).toEqual(["example.com.np 100%_off"]);
    expect((await labels({ filter: "all" })).length).toBe(4);
    expect(await labels({ filter: "awaiting" })).toEqual([]);
  });
  it("searches label and family member; LIKE wildcards are literal", async () => {
    expect(await labels({ filter: "all", q: "ram" })).toEqual(["Passport Ram"]);
    expect(await labels({ filter: "all", q: "100%_" })).toEqual(["example.com.np 100%_off"]);
    expect(await labels({ filter: "all", q: "%" })).toEqual(["example.com.np 100%_off"]);
  });
  it("shows next reminder, channels and held credits", async () => {
    const r = (await listRenewalsForUser(uid, { filter: "active" }, db)).find((x) => x.label === "Bluebook Ba 2")!;
    expect(r.channels).toEqual(["sms"]);
    expect(r.nextAt).not.toBeNull();
    expect(r.heldCredits).toBe(6);
    expect(r.pendingMessages).toBe(2);
  });
  it("never returns another user's reminders", async () => {
    const other = await createUser(db, "+9779841000903");
    expect(await listRenewalsForUser(other, { filter: "all" }, db)).toEqual([]);
  });
});
