import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, principalFor } from "./helpers/db";
import type { Db } from "@/lib/db";
import { prepareReminderAction, confirmPreparedAction } from "@/lib/core/prepared-actions";
import { createGroup } from "@/lib/services/groups";
import { getReminder } from "@/lib/core/reminders";
import type { Principal } from "@/lib/core/principal";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let me: string;
let mcp: Principal;
const now = new Date("2026-10-10T03:00:00Z");

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  me = await createUser(db, "+9779841000401");
  mcp = { ...principalFor(me, "en-NP"), via: "mcp" };
  await fund(db, me, 100);
});
afterAll(async () => close());

describe("assistant (MCP) birthdays", () => {
  it("prepares a yearly birthday from a past birth date, in a group, and confirms it", async () => {
    const g = await createGroup(principalFor(me), { name: "Friends' birthdays", kind: "birthday" }, db);
    const p = await prepareReminderAction(mcp, {
      category: "birthday", label: "Ram Sharma", repeat_yearly: true, group_id: g.id,
      expiry: { calendar: "AD", date: "1995-11-02", local_time: "08:00" }, offsets_minutes: [1440, 0],
    }, db, now);
    expect(p.preview.expiry.ad).toBe("2026-11-02");
    expect(p.confirmationPrompt).toContain("Repeats every year");
    expect(p.preview.lines[0].smsText).toContain("Ram Sharma's birthday");
    const c = await confirmPreparedAction(mcp, { preparedId: p.preparedId, expectedExpiryAd: "2026-11-02", idempotencyKey: "k1" }, db, now);
    const r = await getReminder(mcp, c.reminder.id, db);
    expect(r).toMatchObject({ repeatYearly: true, groupId: g.id, category: "birthday" });
  });

  it("an edit without repeat_yearly keeps the reminder yearly", async () => {
    const p1 = await prepareReminderAction(mcp, { category: "birthday", label: "Sita", repeat_yearly: true, expiry: { calendar: "AD", date: "1990-12-01" }, offsets_minutes: [0] }, db, now);
    const c1 = await confirmPreparedAction(mcp, { preparedId: p1.preparedId, expectedExpiryAd: "2026-12-01", idempotencyKey: "k2" }, db, now);
    const p2 = await prepareReminderAction(mcp, { reminder_id: c1.reminder.id, category: "birthday", label: "Sita K", expiry: { calendar: "AD", date: "1990-12-01" }, offsets_minutes: [1440, 0] }, db, now);
    const c2 = await confirmPreparedAction(mcp, { preparedId: p2.preparedId, expectedExpiryAd: "2026-12-01", idempotencyKey: "k3" }, db, now);
    expect((await getReminder(mcp, c2.reminder.id, db))).toMatchObject({ repeatYearly: true, label: "Sita K" });
  });

  it("refuses another user's group and WhatsApp for occasions", async () => {
    const other = await createUser(db, "+9779841000402");
    const og = await createGroup(principalFor(other), { name: "Theirs", kind: "custom" }, db);
    await expect(prepareReminderAction(mcp, { category: "birthday", label: "X", repeat_yearly: true, group_id: og.id, expiry: { calendar: "AD", date: "1990-12-05" }, offsets_minutes: [0] }, db, now))
      .rejects.toMatchObject({ code: "group_not_found" });
    const p = await prepareReminderAction(mcp, { category: "birthday", label: "Y", repeat_yearly: true, channels: ["whatsapp"], expiry: { calendar: "AD", date: "1990-12-06" }, offsets_minutes: [0] }, db, now);
    expect(p.warnings).toContain("whatsapp_not_for_occasions");
  });
});
