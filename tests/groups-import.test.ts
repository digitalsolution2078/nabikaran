import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, wallet, principalFor } from "./helpers/db";
import type { Db } from "@/lib/db";
import { createReminder, getReminder, updateReminder, previewSchedule, rolloverYearly } from "@/lib/core/reminders";
import { retryAwaitingCredits } from "@/lib/core/wallet";
import { createGroup, deleteGroup, listGroups, updateGroup } from "@/lib/services/groups";
import { commitImport, previewImport, type ImportRequest } from "@/lib/services/bulk-import";
import { listRenewalsForUser } from "@/lib/services/customer-summary";
import { parseDelimited, parseImport, normalizeDate } from "@/lib/csv-import";
import { nextOccurrence, anchorFromInput } from "@/lib/recurrence";
import { renderReminder } from "@/lib/sms/templates";
import { kathmanduToUtc } from "@/lib/time";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let userId: string;
let otherId: string;
const now = new Date("2026-10-10T03:00:00Z");
const p = () => principalFor(userId, "en-NP");

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  userId = await createUser(db, "+9779841000301");
  otherId = await createUser(db, "+9779841000302");
});
afterAll(async () => close());

describe("recurrence", () => {
  it("moves a past birth date to the next occurrence and keeps a future date", () => {
    const a = anchorFromInput("1995-03-15")!;
    expect(nextOccurrence("AD", a, "08:00", now, 1995)!.raw).toBe("2027-03-15");
    expect(nextOccurrence("AD", anchorFromInput("2026-12-01")!, "08:00", now, 2026)!.raw).toBe("2026-12-01");
    // 29 Feb lands on 28 Feb in a common year and back on 29 Feb in a leap year
    expect(nextOccurrence("AD", { month: 2, day: 29 }, "08:00", now)!.raw).toBe("2027-02-28");
    expect(nextOccurrence("AD", { month: 2, day: 29 }, "08:00", new Date("2027-03-01T00:00:00Z"))!.raw).toBe("2028-02-29");
  });
  it("works in Bikram Sambat, including an old birth year", () => {
    const n = nextOccurrence("BS", anchorFromInput("2052-04-15")!, "08:00", now, 2052)!;
    expect(n.raw).toBe("2084-04-15"); // 2083 Shrawan 15 (Jul 2026) has passed
    expect(n.utc.getTime()).toBeGreaterThan(now.getTime());
  });
});

describe("occasion SMS", () => {
  it("birthday wording, one GSM-7 segment, English and Romanized Nepali", () => {
    const expiry = kathmanduToUtc({ year: 2026, month: 11, day: 2 }, "08:00");
    const day = 86_400_000;
    const en = renderReminder({ label: "Ram Sharma", expiryAtUtc: expiry, dueAtUtc: new Date(expiry.getTime() - day), locale: "en-NP", category: "birthday" });
    expect(en.body).toBe("Nabikaran: Ram Sharma's birthday is in 1 day(s), on 2026-11-02. Don't forget to wish!");
    const today = renderReminder({ label: "Ram Sharma", expiryAtUtc: expiry, dueAtUtc: expiry, locale: "ne-NP", category: "birthday" });
    expect(today.body).toContain("Aaja (2026-11-02) Ram Sharma ko janmadin ho");
    for (const cat of ["birthday", "anniversary", "event"]) {
      for (const locale of ["en-NP", "ne-NP"]) {
        const r = renderReminder({ label: "W".repeat(30), expiryAtUtc: expiry, dueAtUtc: new Date(expiry.getTime() - 999 * day), locale, category: cat });
        expect(r.estimate.segments).toBe(1);
        expect(r.estimate.encoding).toBe("GSM-7");
      }
    }
  });
});

describe("groups", () => {
  it("creates, lists, renames; names are unique per user; other users cannot use my group", async () => {
    const g = await createGroup(p(), { name: "Birthdays", kind: "birthday" }, db);
    await expect(createGroup(p(), { name: " birthdays ", kind: "custom" }, db)).rejects.toMatchObject({ code: "group_exists" });
    await createGroup(principalFor(otherId), { name: "Birthdays", kind: "birthday" }, db); // another user may reuse the name
    const renamed = await updateGroup(p(), g.id, { name: "Friends' birthdays", kind: "birthday" }, db);
    expect(renamed.name).toBe("Friends' birthdays");
    expect((await listGroups(userId, db)).map((x) => x.name)).toEqual(["Friends' birthdays"]);
    await fund(db, otherId, 50);
    await expect(
      createReminder(principalFor(otherId), { category: "birthday", label: "X", calendar: "AD", expiryDate: "2026-12-01", localTime: "08:00", offsets: [0], groupId: g.id }, {}, db, now),
    ).rejects.toMatchObject({ code: "group_not_found" });
  });

  it("a yearly birthday in a group is reserved now and keeps all offsets for next year", async () => {
    await fund(db, userId, 100);
    const [g] = await listGroups(userId, db);
    const r = await createReminder(p(), { category: "birthday", label: "Sita", calendar: "AD", expiryDate: "1990-10-12", localTime: "08:00", offsets: [7 * 1440, 1440, 0], groupId: g.id, repeatYearly: true }, {}, db, now);
    // 2026-10-12 is in 2 days: the 7-day reminder is already past this year
    expect(r.reminder.repeatYearly).toBe(true);
    expect(r.reminder.groupId).toBe(g.id);
    expect(r.reminder.jobs).toHaveLength(2);
    const { rows: rules } = await db.query<{ offset_minutes: number }>("select offset_minutes from reminder_rules where renewal_id = $1 and enabled order by 1", [r.reminder.id]);
    expect(rules.map((x) => x.offset_minutes)).toEqual([0, 1440, 7 * 1440]);
    const list = await listRenewalsForUser(userId, { filter: "all", groupId: g.id }, db);
    expect(list.map((x) => x.label)).toEqual(["Sita"]);
    expect(list[0]).toMatchObject({ groupName: g.name, repeatYearly: true });
  });

  it("WhatsApp is refused for occasions", async () => {
    const pr = await previewSchedule(p(), { label: "Hari", category: "birthday", calendar: "AD", expiryDate: "2026-12-01", localTime: "08:00", offsets: [0], channels: ["whatsapp"] }, db, now);
    expect(pr.warnings).toContain("whatsapp_not_for_occasions");
  });

  it("rolls a finished year over to the next date and reserves it; unfunded years wait for a top-up", async () => {
    const created = await createReminder(p(), { category: "birthday", label: "Gita", calendar: "AD", expiryDate: "2000-10-11", localTime: "08:00", offsets: [1440, 0], repeatYearly: true }, {}, db, now);
    const id = created.reminder.id;
    // Pretend this year's messages were sent.
    await db.query("update reminder_jobs set status = 'delivered' where renewal_id = $1", [id]);
    const later = new Date("2026-10-12T03:00:00Z");
    // Not enough credits for next year: rollover still happens, messages wait for credits.
    await db.query("update wallets set posted_balance_credits = reserved_credits where user_id = $1", [userId]);
    const out = await rolloverYearly(db, later);
    expect(out.rolled).toBeGreaterThanOrEqual(1);
    const after = await getReminder(p(), id, db);
    expect(after!.inputDate).toBe("2027-10-11");
    expect(after!.cycleNo).toBe(2);
    expect(after!.jobs.map((j) => j.status).sort()).toEqual(["awaiting_credits", "awaiting_credits"]);
    // A top-up schedules them.
    await fund(db, userId, 50);
    expect(await retryAwaitingCredits(userId, db)).toBe(2);
    expect((await getReminder(p(), id, db))!.jobs.every((j) => j.status === "scheduled")).toBe(true);
    // Running again does nothing (next date is a year away).
    expect((await rolloverYearly(db, later)).rolled).toBe(0);
  });

  it("an edit without group/yearly fields keeps them", async () => {
    const [g] = await listGroups(userId, db);
    const r = (await listRenewalsForUser(userId, { filter: "all", groupId: g.id }, db))[0];
    const upd = await updateReminder(p(), r.id, { category: "birthday", label: "Sita K", calendar: "AD", expiryDate: "1990-10-12", localTime: "08:00", offsets: [1440, 0] }, {}, db, now);
    expect(upd.reminder).toMatchObject({ groupId: g.id, repeatYearly: true, label: "Sita K" });
  });

  it("deleting a group keeps its reminders by default, or cancels them and returns credits", async () => {
    const g2 = await createGroup(p(), { name: "Office", kind: "custom" }, db);
    const r = await createReminder(p(), { category: "event", label: "Team lunch", calendar: "AD", expiryDate: "2026-11-20", localTime: "12:00", offsets: [0], groupId: g2.id }, {}, db, now);
    const before = await wallet(db, userId);
    expect(await deleteGroup(p(), g2.id, { cancelReminders: true }, db)).toEqual({ cancelledReminders: 1 });
    expect((await wallet(db, userId)).reserved).toBeLessThan(before.reserved);
    expect((await getReminder(p(), r.reminder.id, db))!.status).toBe("cancelled");
    const [g] = await listGroups(userId, db);
    await deleteGroup(p(), g.id, {}, db);
    const sita = (await listRenewalsForUser(userId, { filter: "all" }, db)).find((x) => x.label === "Sita K")!;
    expect(sita).toMatchObject({ status: "active", groupId: null });
  });
});

describe("CSV parsing", () => {
  const defaults = { calendar: "BS" as const, category: "birthday" as const, localTime: "08:00", offsetsDays: [1, 0], repeatYearly: true };
  it("handles quotes, tabs, Nepali digits, headers in any order and per-row overrides", () => {
    expect(parseDelimited('a,"b, c","say ""hi"""\n')).toEqual([["a", "b, c", 'say "hi"']]);
    expect(parseDelimited("x\ty\n1\t2")).toEqual([["x", "y"], ["1", "2"]]);
    expect(normalizeDate("२०५२/४/५")).toBe("2052-04-05");
    const r = parseImport("Date,Name,Calendar,Remind,Repeat\n2052-04-15,Ram,,7;1,\n1996-11-02,Sita,AD,,no\n,Hari,,,\nbad,Gopal,,,\n2052-04-15,Ram,,,", defaults);
    expect(r.headerDetected).toBe(true);
    expect(r.rows[0]).toMatchObject({ line: 2, label: "Ram", calendar: "BS", offsets: [7 * 1440, 1440], repeatYearly: true, errors: [] });
    expect(r.rows[1]).toMatchObject({ label: "Sita", calendar: "AD", repeatYearly: false, errors: [] });
    expect(r.rows[2].errors).toEqual(["missing_date"]);
    expect(r.rows[3].errors).toEqual(["bad_date"]);
    expect(r.rows[4].duplicate).toBe(true);
  });
  it("works without a header (name,date)", () => {
    const r = parseImport("Ram,2052-04-15\nSita,2053-01-32", defaults);
    expect(r.headerDetected).toBe(false);
    expect(r.rows.map((x) => x.errors)).toEqual([[], []]); // BS day 32 is allowed for yearly dates (clamped per year)
  });
});

describe("bulk import", () => {
  let importer: string;
  const base = (csv: string, extra: Partial<ImportRequest> = {}): ImportRequest => ({
    csv,
    newGroup: { name: "Birthdays", kind: "birthday" },
    defaults: { calendar: "BS", category: "birthday", localTime: "08:00", offsetsDays: [1, 0], repeatYearly: true },
    ...extra,
  });
  beforeAll(async () => {
    importer = await createUser(db, "+9779841000303");
  });
  const ip = () => principalFor(importer, "en-NP");

  it("preview prices every row; errors are shown per row", async () => {
    const pr = await previewImport(ip(), base("name,date\nRam,2052-04-15\nSita,2053-08-20\nBad,2053-13-01"), db, now);
    expect(pr.validRows).toBe(2);
    expect(pr.invalidRows).toBe(1);
    expect(pr.rows[0].nextDate).toBe("2084-04-15");
    expect(pr.rows[0].smsSample).toContain("Ram's birthday");
    expect(pr.messages).toBe(4);
    expect(pr.totalCredits).toBe(12); // 4 SMS x 3 credits
    expect(pr.sufficient).toBe(false);
  });

  it("is all-or-nothing: refuses without credits, refuses rows with errors unless skipped, then imports into a new group", async () => {
    const req = base("name,date\nRam,2052-04-15\nSita,2053-08-20\nBad,2053-13-01");
    await expect(commitImport(ip(), { ...req, skipInvalid: true }, {}, db, now)).rejects.toMatchObject({ code: "insufficient_credits", detail: { neededCredits: 12 } });
    expect((await db.query("select 1 from reminder_groups where owner_user_id = $1", [importer])).rows).toHaveLength(0);
    await fund(db, importer, 20);
    await expect(commitImport(ip(), req, {}, db, now)).rejects.toMatchObject({ code: "import_has_errors" });
    const res = await commitImport(ip(), { ...req, skipInvalid: true }, { idempotencyKey: "imp-1" }, db, now);
    expect(res).toMatchObject({ created: 2, reservedCredits: 12, replayed: false });
    expect((await wallet(db, importer)).reserved).toBe(12);
    const again = await commitImport(ip(), { ...req, skipInvalid: true }, { idempotencyKey: "imp-1" }, db, now);
    expect(again).toMatchObject({ created: 2, replayed: true });
    const rows = await listRenewalsForUser(importer, { filter: "all", groupId: res.groupId }, db);
    expect(rows.map((r) => r.label).sort()).toEqual(["Ram", "Sita"]);
    expect(rows.every((r) => r.repeatYearly && r.groupName === "Birthdays")).toBe(true);
  });

  it("cannot import into someone else's group", async () => {
    const [g] = await listGroups(userId, db).then((x) => (x.length ? x : listGroups(otherId, db)));
    await expect(commitImport(ip(), base("name,date\nX,2052-04-15", { newGroup: null, groupId: g.id }), {}, db, now)).rejects.toMatchObject({ code: "group_not_found" });
  });
});
