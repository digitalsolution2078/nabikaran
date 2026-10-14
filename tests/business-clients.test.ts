import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund, inDays, principalFor, wallet } from "./helpers/db";
import type { Db } from "@/lib/db";
import { MockSmsProvider } from "@/lib/providers/sms/mock";
import { setSmsProviderForTests } from "@/lib/providers/sms";
import { savePushSubscription, setPushSender } from "@/lib/services/push";
import { createReminder, setReminderStatus, updateReminder } from "@/lib/core/reminders";
import { runDispatcher } from "@/lib/services/dispatcher";
import { archiveClient, blockRecipient, createClient, listClients, setBusinessName, unblockRecipient, updateClient } from "@/lib/services/clients";

let db: Db;
let close: () => Promise<void> = async () => undefined;
const sms = new MockSmsProvider();
const pushes: string[] = [];
const base = { notes: null, familyMemberLabel: null, localTime: "09:00" } as const;
let owner: string;
let other: string;
let admin: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  setSmsProviderForTests(sms);
  setPushSender(async (_sub, payload) => {
    pushes.push(payload);
    return { statusCode: 201 };
  });
  owner = await createUser(db, "+9779841008001");
  other = await createUser(db, "+9779841008002");
  admin = await createUser(db, "+9779841008000", "admin");
  await fund(db, owner, 100);
  await fund(db, other, 100);
});
afterAll(async () => {
  setSmsProviderForTests(undefined);
  setPushSender(null);
  await close();
});

const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? String(e));

describe("business accounts: clients", () => {
  it("business tools need a short plain business name; clients need business tools and consent", async () => {
    expect(await code(createClient(owner, { name: "Hari", phone: "9851000001", note: null, consent: true }, db))).toBe("business_required");
    expect(await code(setBusinessName(owner, "न", db))).toBe("invalid_business_name");
    expect(await code(setBusinessName(owner, "A very long business name here", db))).toBe("invalid_business_name");
    expect(await setBusinessName(owner, "Ram Motors", db)).toBe("Ram Motors");
    expect(await code(createClient(owner, { name: "Hari", phone: "9851000001", note: null, consent: false }, db))).toBe("consent_required");
    expect(await code(createClient(owner, { name: "Hari", phone: "12345", note: null, consent: true }, db))).toBe("invalid_phone");
    const c = await createClient(owner, { name: "Hari Thapa", phone: "985-1000001", note: "Pulsar 150", consent: true }, db);
    expect(c).toMatchObject({ name: "Hari Thapa", phone: "+9779851000001", status: "active", activeReminders: 0 });
    expect(await code(createClient(owner, { name: "Hari again", phone: "+977 9851000001", note: null, consent: true }, db))).toBe("client_exists");
    const edited = await updateClient(owner, c.id, { name: "Hari B. Thapa", phone: "9851000001", note: null }, db);
    expect(edited.name).toBe("Hari B. Thapa");
    expect((await listClients(owner, { q: "hari" }, db)).map((x) => x.id)).toEqual([c.id]);
    expect(await listClients(other, {}, db)).toEqual([]);
  });

  it("client reminders go by SMS to the client, signed with the business name; the owner pays and gets an app copy", async () => {
    const [c] = await listClients(owner, {}, db);
    await savePushSubscription(owner, { endpoint: "https://fcm.googleapis.com/fcm/send/owner", keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } }, "test", db);
    // Only SMS (+ the owner's app copy) for clients.
    expect(await code(createReminder(principalFor(owner), { category: "other", label: "Bluebook", calendar: "AD", expiryDate: inDays(10), offsets: [1440], channels: ["whatsapp"], clientId: c.id, ...base }, {}, db))).toBe("client_sms_only");
    // Someone else's client is not found.
    expect(await code(createReminder(principalFor(other), { category: "other", label: "Bluebook", calendar: "AD", expiryDate: inDays(10), offsets: [1440], channels: ["sms"], clientId: c.id, ...base }, {}, db))).toBe("business_required");

    const before = await wallet(db, owner);
    const { reminder } = await createReminder(principalFor(owner), { category: "other", label: "Pulsar bluebook", calendar: "AD", expiryDate: inDays(10), offsets: [1440], channels: ["sms", "push"], clientId: c.id, ...base }, {}, db);
    expect(reminder.clientId).toBe(c.id);
    expect((await wallet(db, owner)).available).toBeLessThan(before.available);
    expect((await listClients(owner, {}, db))[0].activeReminders).toBe(1);

    await db.query("update reminder_jobs set due_at_utc = now() - interval '1 minute' where renewal_id = $1", [reminder.id]);
    await runDispatcher(db, new Date());
    const toClient = sms.sent.filter((m) => m.to === "+9779851000001");
    expect(toClient).toHaveLength(1);
    expect(toClient[0].text).toContain("Ram Motors");
    expect(sms.sent.some((m) => m.to === "+9779841008001")).toBe(false);
    expect(pushes.some((p) => p.includes("Hari B. Thapa"))).toBe(true);
  });

  it("a client with active reminders cannot be archived, and business tools cannot be switched off", async () => {
    const [c] = await listClients(owner, {}, db);
    expect(await code(archiveClient(owner, c.id, db))).toBe("client_has_reminders");
    expect(await code(setBusinessName(owner, null, db))).toBe("clients_have_reminders");
  });

  it("an edit can move a reminder back to me; deleting the last one lets the client be archived", async () => {
    const c = await createClient(owner, { name: "Sita", phone: "9851000002", note: null, consent: true }, db);
    const { reminder } = await createReminder(principalFor(owner), { category: "other", label: "Insurance", calendar: "AD", expiryDate: inDays(20), offsets: [1440], channels: ["sms"], clientId: c.id, ...base }, {}, db);
    const moved = await updateReminder(principalFor(owner), reminder.id, { category: "other", label: "Insurance", calendar: "AD", expiryDate: inDays(20), offsets: [1440], channels: ["sms"], clientId: null, ...base }, {}, db);
    expect(moved.reminder.clientId).toBeNull();
    // Omitting clientId keeps the current value.
    const kept = await updateReminder(principalFor(owner), reminder.id, { category: "other", label: "Insurance 2", calendar: "AD", expiryDate: inDays(20), offsets: [1440], channels: ["sms"], ...base }, {}, db);
    expect(kept.reminder.clientId).toBeNull();
    await archiveClient(owner, c.id, db);
    expect((await listClients(owner, { archived: true }, db)).map((x) => x.name)).toContain("Sita");
    await setReminderStatus(principalFor(owner), reminder.id, "delete", {}, db);
  });

  it("admins can block a number: its pending client reminders are cancelled with credits returned, and it cannot be added again", async () => {
    const c = await createClient(owner, { name: "Gita", phone: "9851000003", note: null, consent: true }, db);
    await createReminder(principalFor(owner), { category: "other", label: "Licence", calendar: "AD", expiryDate: inDays(30), offsets: [1440, 7 * 1440], channels: ["sms"], clientId: c.id, ...base }, {}, db);
    const held = (await wallet(db, owner)).reserved;
    const r = await blockRecipient({ id: admin }, "9851000003", "asked to stop", db);
    expect(r.cancelled).toBe(2);
    expect((await wallet(db, owner)).reserved).toBeLessThan(held);
    expect(await code(createClient(other, { name: "Gita", phone: "9851000003", note: null, consent: true }, db))).toBe("business_required");
    await setBusinessName(other, "Shyam Insurance", db);
    expect(await code(createClient(other, { name: "Gita", phone: "9851000003", note: null, consent: true }, db))).toBe("recipient_blocked");
    await unblockRecipient({ id: admin }, "9851000003", db);
    expect(await code(createClient(other, { name: "Gita", phone: "9851000003", note: null, consent: true }, db))).toBe("ok");
  });
});

describe("business accounts: Excel / CSV import with client columns", () => {
  const defaults = { calendar: "AD" as const, category: "other" as const, localTime: "09:00", offsetsDays: [7, 1], repeatYearly: false };
  const csv = (rows: string[]) => ["name,date,client,client phone", ...rows].join("\n");
  const d = (days: number) => inDays(days);

  it("rows with a client phone create (or reuse) clients and send to them; consent is required", async () => {
    const imp = await import("@/lib/services/bulk-import");
    const p = principalFor(owner);
    const req = { csv: csv([`Pulsar bluebook,${d(40)},Ram Bahadur,9851000010`, `Splendor insurance,${d(50)},Ram Bahadur,985-1000010`, `Scooty bluebook,${d(60)},Maya,9851000011`, `Bad number,${d(60)},X,12345`]), defaults, skipInvalid: true };
    const pr = await imp.previewImport(p, req, db);
    expect(pr.rows.map((r) => r.client)).toEqual(["Ram Bahadur · 9851000010", "Ram Bahadur · 9851000010", "Maya · 9851000011", null]);
    expect(pr.rows[3].errors).toContain("bad_phone");
    await fund(db, owner, 50);
    await expect(imp.commitImport(p, req, {}, db)).rejects.toMatchObject({ code: "consent_required" });
    const r = await imp.commitImport(p, { ...req, clientConsent: true }, {}, db);
    expect(r.created).toBe(3);
    const clients = await listClients(owner, {}, db);
    expect(clients.find((c) => c.phone === "+9779851000010")!.activeReminders).toBe(2);
    expect(clients.find((c) => c.phone === "+9779851000011")!.activeReminders).toBe(1);
  });

  it("without business tools, client rows are flagged", async () => {
    const imp = await import("@/lib/services/bulk-import");
    const u = await createUser(db, "+9779841008009");
    const pr = await imp.previewImport(principalFor(u), { csv: csv([`Bike,${d(40)},Ram,9851000012`]), defaults }, db);
    expect(pr.rows[0].errors).toContain("client_needs_business");
  });
});
