import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser } from "./helpers/db";
import type { Db } from "@/lib/db";
import { can } from "@/lib/auth/rbac";
import { MockEmailProvider, setEmailProviderForTests } from "@/lib/providers/email";
import { createTicket, customerReply, getAttachment, getTicketForCustomer, getTicketForStaff, listMyTickets, listTicketsForStaff, staffAction, supportCounts } from "@/lib/services/support";

let db: Db;
let close: () => Promise<void> = async () => undefined;
const mail = new MockEmailProvider();
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  setEmailProviderForTests(mail);
});
afterAll(async () => {
  setEmailProviderForTests(undefined);
  await close();
});

describe("support tickets", () => {
  it("only support-capable staff can manage tickets", () => {
    expect(can("support", "support.manage")).toBe(true);
    expect(can("finance", "support.manage")).toBe(true);
    expect(can("admin", "support.manage")).toBe(true);
    expect(can("super_admin", "support.manage")).toBe(true);
    expect(can("counter", "support.manage")).toBe(false);
    expect(can("auditor", "support.manage")).toBe(false);
    expect(can("user", "support.manage")).toBe(false);
  });

  it("a signed-in customer opens, sees and answers their own ticket only", async () => {
    const uid = await createUser(db, "+9779841001001");
    const other = await createUser(db, "+9779841001002");
    const t = await createTicket(uid, { category: "payment", subject: "Top-up missing", body: "Paid NPR 500 by eSewa, txn 123" }, { contentType: "image/png", bytes: png }, db);
    expect(t.ref).toMatch(/^NB-\d{4,}$/);
    expect(t.guestToken).toBeNull();
    expect((await listMyTickets(uid, db)).map((x) => x.id)).toEqual([t.id]);
    expect(await getTicketForCustomer({ userId: other, ticketId: t.id }, db)).toBeNull();
    const mine = await getTicketForCustomer({ userId: uid, ticketId: t.id }, db);
    expect(mine?.ticket.priority).toBe("high"); // payment tickets go first
    expect(mine?.messages).toHaveLength(1);
    const att = mine!.messages[0].attachment!;
    expect(await getAttachment(att.id, { userId: uid }, db)).not.toBeNull();
    expect(await getAttachment(att.id, { userId: other }, db)).toBeNull();
    expect(await getAttachment(att.id, { staff: true }, db)).not.toBeNull();
    await expect(customerReply({ userId: other, ticketId: t.id }, "hi", null, db)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects fake or oversized attachments", async () => {
    const uid = await createUser(db, "+9779841001003");
    await expect(createTicket(uid, { category: "other", subject: "File", body: "See attached file" }, { contentType: "image/png", bytes: Buffer.from("not an image") }, db)).rejects.toMatchObject({ code: "invalid_attachment" });
    await expect(createTicket(uid, { category: "other", subject: "File", body: "See attached file" }, { contentType: "image/png", bytes: Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]) }, db)).rejects.toMatchObject({ code: "attachment_too_large" });
  });

  it("a visitor needs a name and a contact, and uses a private link", async () => {
    await expect(createTicket(null, { category: "account", subject: "Cannot sign in", body: "OTP does not come" }, null, db)).rejects.toMatchObject({ code: "name_required" });
    await expect(createTicket(null, { category: "account", subject: "Cannot sign in", body: "OTP does not come", guestName: "Ram" }, null, db)).rejects.toMatchObject({ code: "contact_required" });
    await expect(createTicket(null, { category: "account", subject: "Cannot sign in", body: "OTP does not come", guestName: "Ram", guestPhone: "12345" }, null, db)).rejects.toMatchObject({ code: "invalid_phone" });
    const t = await createTicket(null, { category: "account", subject: "Cannot sign in", body: "OTP does not come", guestName: "Ram", guestPhone: "9841001004", guestEmail: "ram@example.com" }, null, db);
    expect(t.guestToken).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    const { rows } = await db.query<{ access_token_hash: string }>("select access_token_hash from support_tickets where id = $1", [t.id]);
    expect(rows[0].access_token_hash).not.toBe(t.guestToken); // only the hash is stored
    expect((await getTicketForCustomer({ token: t.guestToken! }, db))?.ticket.customer).toMatchObject({ name: "Ram", phone: "+9779841001004", guest: true });
    expect(await getTicketForCustomer({ token: "x".repeat(32) }, db)).toBeNull();
  });

  it("staff reply notifies, internal notes stay hidden, statuses flow", async () => {
    const staff = await createUser(db, "+9779841001005");
    const t = await createTicket(null, { category: "reminder", subject: "SMS not received", body: "Bluebook SMS did not come", guestName: "Sita", guestEmail: "sita@example.com" }, null, db);
    const before = mail.sent.length;
    await staffAction({ id: staff }, t.id, { action: "note", body: "Checked provider log: delivered." }, null, db);
    const after = await staffAction({ id: staff }, t.id, { action: "reply", body: "Your SMS was delivered at 9:00. Please check the SMS inbox.", status: "waiting_customer" }, null, db);
    expect(after.status).toBe("waiting_customer");
    expect(after.assignedToId).toBe(staff);
    expect(mail.sent.length).toBe(before + 1);
    expect(mail.sent.at(-1)).toMatchObject({ to: "sita@example.com" });
    expect(mail.sent.at(-1)!.text).toContain(t.ref);

    const customerView = await getTicketForCustomer({ token: t.guestToken! }, db);
    expect(customerView!.messages.map((m) => m.author)).toEqual(["customer", "staff"]); // no internal note
    const staffView = await getTicketForStaff(t.id, db);
    expect(staffView!.messages.some((m) => m.internal)).toBe(true);

    await customerReply({ token: t.guestToken! }, "Found it, thanks!", null, db);
    expect((await getTicketForStaff(t.id, db))!.ticket.status).toBe("open");
    await staffAction({ id: staff }, t.id, { action: "status", status: "closed" }, null, db);
    await expect(customerReply({ token: t.guestToken! }, "One more thing", null, db)).rejects.toMatchObject({ code: "ticket_closed" });
  });

  it("staff list filters by status, category and search", async () => {
    const all = await listTicketsForStaff({ status: "all" }, db);
    expect(all.length).toBeGreaterThanOrEqual(3);
    const active = await listTicketsForStaff({}, db);
    expect(active.every((x) => x.status === "open" || x.status === "waiting_customer")).toBe(true);
    expect((await listTicketsForStaff({ status: "all", category: "payment" }, db)).every((x) => x.category === "payment")).toBe(true);
    const byName = await listTicketsForStaff({ status: "all", q: "Ram" }, db);
    expect(byName.map((x) => x.customer.name)).toContain("Ram");
    const one = all[0];
    expect((await listTicketsForStaff({ status: "all", q: one.ref }, db)).map((x) => x.id)).toContain(one.id);
    const c = await supportCounts(db);
    expect(c.open).toBeGreaterThanOrEqual(1);
  });
});
