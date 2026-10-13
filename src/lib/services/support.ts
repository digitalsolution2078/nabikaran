import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getDb, type Db } from "../db";
import { HttpError } from "../core/errors";
import { audit } from "../core/audit";
import { env } from "../env";
import { normalizeNepalPhone } from "../phone";
import { sniffType } from "./manual-topups";
import { sendPushToUser } from "./push";
import { getEmailProvider, textToHtml } from "../providers/email";

/**
 * Support tickets. A signed-in customer's tickets belong to their account; a
 * visitor gets a private link (random token, only its hash is stored) to read
 * and answer their ticket. Staff with support.manage reply, add internal notes
 * and change the status. Staff replies notify the customer (free app
 * notification, or email for a visitor who gave one).
 */
export const SUPPORT_CATEGORIES = ["payment", "reminder", "account", "pro", "other"] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];
export const SUPPORT_STATUSES = ["open", "waiting_customer", "resolved", "closed"] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

const who = (id: string) => ({ userId: id, via: "web" as const, scopes: [], locale: "en" });
const hashToken = (t: string) => createHash("sha256").update(`nabikaran-ticket|${t}`).digest("hex");

export const newTicketSchema = z.object({
  category: z.enum(SUPPORT_CATEGORIES),
  subject: z.string().trim().min(3).max(140),
  body: z.string().trim().min(5).max(5000),
  guestName: z.string().trim().max(80).optional().nullable(),
  guestPhone: z.string().trim().max(20).optional().nullable(),
  guestEmail: z.string().trim().max(160).optional().nullable(),
});

export interface Attachment { contentType: string; bytes: Buffer }

export interface TicketSummary {
  id: string;
  number: number;
  ref: string;
  category: SupportCategory;
  subject: string;
  status: SupportStatus;
  priority: "normal" | "high";
  createdAt: string;
  updatedAt: string;
  lastCustomerAt: string;
  lastStaffAt: string | null;
  customer: { userId: string | null; name: string | null; phone: string | null; email: string | null; guest: boolean };
  assignedTo: string | null;
  assignedToId: string | null;
  messages?: number;
}

export interface TicketMessage {
  id: string;
  author: "customer" | "staff" | "system";
  authorName: string | null;
  body: string;
  internal: boolean;
  createdAt: string;
  attachment: { id: string; contentType: string; size: number } | null;
}

export const ticketRef = (n: number) => `NB-${String(n).padStart(4, "0")}`;

function checkAttachment(a: Attachment | null | undefined): Attachment | null {
  if (!a || a.bytes.length === 0) return null;
  if (a.bytes.length > MAX_ATTACHMENT_BYTES) throw new HttpError(400, "The file must be 3 MB or smaller.", "attachment_too_large");
  const real = sniffType(a.bytes);
  if (!real || real !== a.contentType) throw new HttpError(400, "Attach a PNG, JPG, WebP or PDF file.", "invalid_attachment");
  return a;
}

async function addMessage(db: Db, ticketId: string, author: { kind: "customer" | "staff" | "system"; userId: string | null }, body: string, internal: boolean, attachment: Attachment | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into support_messages (ticket_id, author_user_id, author_kind, body, internal) values ($1,$2,$3,$4,$5) returning id",
    [ticketId, author.userId, author.kind, body, internal],
  );
  if (attachment) {
    await db.query("insert into support_attachments (message_id, content_type, size_bytes, bytes) values ($1,$2,$3,$4)", [rows[0].id, attachment.contentType, attachment.bytes.length, attachment.bytes]);
  }
  return rows[0].id;
}

/** Open a ticket. `userId` for a signed-in customer; otherwise guest contact details are required. */
export async function createTicket(
  userId: string | null,
  raw: z.input<typeof newTicketSchema>,
  attachment: Attachment | null = null,
  db: Db = getDb(),
): Promise<{ id: string; number: number; ref: string; guestToken: string | null }> {
  const input = newTicketSchema.parse(raw);
  const file = checkAttachment(attachment);
  let guest: { name: string; phone: string | null; email: string | null; token: string } | null = null;
  if (!userId) {
    const name = input.guestName?.trim();
    if (!name || name.length < 2) throw new HttpError(400, "Please write your name.", "name_required");
    const phone = input.guestPhone ? normalizeNepalPhone(input.guestPhone) : null;
    if (input.guestPhone && !phone) throw new HttpError(400, "Enter a valid Nepali mobile number.", "invalid_phone");
    const email = input.guestEmail ? input.guestEmail.toLowerCase() : null;
    if (email && !z.string().email().safeParse(email).success) throw new HttpError(400, "Enter a valid email address.", "invalid_email");
    if (!phone && !email) throw new HttpError(400, "Give a mobile number or an email so we can reach you.", "contact_required");
    guest = { name, phone, email, token: randomBytes(24).toString("base64url") };
  }
  return db.tx(async (tx) => {
    const { rows } = await tx.query<{ id: string; number: string }>(
      `insert into support_tickets (user_id, guest_name, guest_phone, guest_email, access_token_hash, category, subject, priority)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, number::text`,
      [userId, guest?.name ?? null, guest?.phone ?? null, guest?.email ?? null, guest ? hashToken(guest.token) : null, input.category, input.subject, input.category === "payment" ? "high" : "normal"],
    );
    const t = rows[0];
    await addMessage(tx, t.id, { kind: "customer", userId }, input.body, false, file);
    await audit(tx, userId ? who(userId) : null, "support.ticket_opened", { type: "support_ticket", id: t.id }, { category: input.category, guest: !userId });
    return { id: t.id, number: Number(t.number), ref: ticketRef(Number(t.number)), guestToken: guest?.token ?? null };
  });
}

const SUMMARY_SQL = `
  select t.id, t.number::text, t.category, t.subject, t.status, t.priority, t.created_at, t.updated_at, t.last_customer_at, t.last_staff_at,
         t.user_id, coalesce(u.display_name, t.guest_name) as name, coalesce(u.phone_e164, t.guest_phone) as phone,
         coalesce(case when u.email_verified_at is not null then u.email end, t.guest_email) as email,
         (t.user_id is null) as guest, coalesce(a.display_name, a.phone_e164) as assigned, t.assigned_to as assigned_id,
         (select count(*) from support_messages m where m.ticket_id = t.id and not m.internal)::int as messages
    from support_tickets t
    left join users u on u.id = t.user_id
    left join users a on a.id = t.assigned_to`;

type SummaryRow = {
  id: string; number: string; category: SupportCategory; subject: string; status: SupportStatus; priority: "normal" | "high";
  created_at: string; updated_at: string; last_customer_at: string; last_staff_at: string | null;
  user_id: string | null; name: string | null; phone: string | null; email: string | null; guest: boolean; assigned: string | null; assigned_id: string | null; messages: number;
};

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
function toSummary(r: SummaryRow): TicketSummary {
  return {
    id: r.id, number: Number(r.number), ref: ticketRef(Number(r.number)), category: r.category, subject: r.subject, status: r.status, priority: r.priority,
    createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, lastCustomerAt: iso(r.last_customer_at)!, lastStaffAt: iso(r.last_staff_at),
    customer: { userId: r.user_id, name: r.name, phone: r.phone, email: r.email, guest: r.guest }, assignedTo: r.assigned, assignedToId: r.assigned_id, messages: r.messages,
  };
}

async function messagesOf(db: Db, ticketId: string, includeInternal: boolean): Promise<TicketMessage[]> {
  const { rows } = await db.query<{ id: string; author_kind: TicketMessage["author"]; name: string | null; body: string; internal: boolean; created_at: string; att_id: string | null; att_type: string | null; att_size: number | null }>(
    `select m.id, m.author_kind, case when m.author_kind = 'staff' then coalesce(u.display_name, 'Nabikaran support') else u.display_name end as name,
            m.body, m.internal, m.created_at, a.id as att_id, a.content_type as att_type, a.size_bytes as att_size
       from support_messages m left join users u on u.id = m.author_user_id
       left join support_attachments a on a.message_id = m.id
      where m.ticket_id = $1 and ($2 or not m.internal) order by m.created_at, m.id`,
    [ticketId, includeInternal],
  );
  return rows.map((r) => ({
    id: r.id, author: r.author_kind, authorName: r.name, body: r.body, internal: r.internal, createdAt: iso(r.created_at)!,
    attachment: r.att_id ? { id: r.att_id, contentType: r.att_type!, size: r.att_size! } : null,
  }));
}

export async function listMyTickets(userId: string, db: Db = getDb()): Promise<TicketSummary[]> {
  const { rows } = await db.query<SummaryRow>(`${SUMMARY_SQL} where t.user_id = $1 order by t.updated_at desc limit 100`, [userId]);
  return rows.map(toSummary);
}

/** A customer's own ticket (by account) or a visitor's ticket (by private link token). */
export async function getTicketForCustomer(access: { userId: string; ticketId: string } | { token: string }, db: Db = getDb()): Promise<{ ticket: TicketSummary; messages: TicketMessage[] } | null> {
  const { rows } = "token" in access
    ? await db.query<SummaryRow>(`${SUMMARY_SQL} where t.access_token_hash = $1`, [hashToken(access.token)])
    : await db.query<SummaryRow>(`${SUMMARY_SQL} where t.id = $1 and t.user_id = $2`, [access.ticketId, access.userId]);
  if (!rows[0]) return null;
  return { ticket: toSummary(rows[0]), messages: await messagesOf(db, rows[0].id, false) };
}

/** Customer (or visitor) answers. Re-opens a resolved ticket; a closed one cannot be answered. */
export async function customerReply(access: { userId: string; ticketId: string } | { token: string }, body: string, attachment: Attachment | null = null, db: Db = getDb()): Promise<void> {
  const text = body.trim();
  if (text.length < 1 || text.length > 5000) throw new HttpError(400, "Write your message (up to 5,000 characters).", "invalid_body");
  const found = await getTicketForCustomer(access, db);
  if (!found) throw new HttpError(404, "Ticket not found", "not_found");
  if (found.ticket.status === "closed") throw new HttpError(409, "This ticket is closed. Please open a new one.", "ticket_closed");
  const file = checkAttachment(attachment);
  await db.tx(async (tx) => {
    await addMessage(tx, found.ticket.id, { kind: "customer", userId: "userId" in access ? access.userId : null }, text, false, file);
    await tx.query("update support_tickets set status = 'open', last_customer_at = now(), updated_at = now() where id = $1", [found.ticket.id]);
  });
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

export interface TicketFilter { status?: SupportStatus | "active" | "all"; category?: SupportCategory | null; q?: string | null }

export async function listTicketsForStaff(f: TicketFilter = {}, db: Db = getDb()): Promise<TicketSummary[]> {
  const status = f.status ?? "active";
  const q = f.q?.trim() ?? "";
  const num = /^(nb-?)?\d+$/i.test(q) ? Number(q.replace(/\D/g, "")) : null;
  const { rows } = await db.query<SummaryRow>(
    `${SUMMARY_SQL}
      where ($1 = 'all' or ($1 = 'active' and t.status in ('open','waiting_customer')) or t.status = $1)
        and ($2::text is null or t.category = $2)
        and ($3 = '' or t.number = $4 or t.subject ilike '%' || $3 || '%' or coalesce(u.phone_e164, t.guest_phone, '') like '%' || $3 || '%'
             or coalesce(u.display_name, t.guest_name, '') ilike '%' || $3 || '%')
      order by (t.status = 'open') desc, t.priority = 'high' desc, t.last_customer_at desc
      limit 300`,
    [status, f.category ?? null, q, num ?? -1],
  );
  return rows.map(toSummary);
}

export async function supportCounts(db: Db = getDb()): Promise<{ open: number; waiting: number }> {
  const { rows } = await db.query<{ open: number; waiting: number }>(
    "select count(*) filter (where status = 'open')::int as open, count(*) filter (where status = 'waiting_customer')::int as waiting from support_tickets",
  );
  return rows[0] ?? { open: 0, waiting: 0 };
}

export async function getTicketForStaff(ticketId: string, db: Db = getDb()): Promise<{ ticket: TicketSummary; messages: TicketMessage[] } | null> {
  const { rows } = await db.query<SummaryRow>(`${SUMMARY_SQL} where t.id = $1`, [ticketId]);
  if (!rows[0]) return null;
  return { ticket: toSummary(rows[0]), messages: await messagesOf(db, ticketId, true) };
}

async function notifyCustomer(t: TicketSummary, preview: string, db: Db): Promise<void> {
  const body = `Support replied to ${t.ref}: ${preview.slice(0, 120)}${preview.length > 120 ? "…" : ""}`;
  if (t.customer.userId) {
    await sendPushToUser(t.customer.userId, { title: "Nabikaran support", body, url: `/support/${t.id}`, tag: `ticket-${t.id}` }, db).catch(() => 0);
  }
  if (t.customer.email) {
    const provider = await getEmailProvider(db).catch(() => null);
    if (!provider) return;
    const link = t.customer.userId ? `${env.appUrl.replace(/\/$/, "")}/support/${t.id}` : null;
    const text = `Namaste${t.customer.name ? ` ${t.customer.name}` : ""},\n\nOur support team replied to your ticket ${t.ref} (“${t.subject}”):\n\n${preview}\n\n${link ? "Open the ticket to answer." : "Use the private link you received when you opened the ticket to answer."}\n\nNabikaran`;
    await provider.send({ to: t.customer.email, subject: `Re: ${t.subject} [${t.ref}]`, text, html: textToHtml(text, link ? { href: link, label: "Open ticket" } : undefined), idempotencyKey: `ticket-reply-${t.id}-${Date.now()}` }).catch((e: Error) => console.warn(`[support] email failed: ${e.message}`));
  }
}

export const staffActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reply"), body: z.string().trim().min(1).max(5000), status: z.enum(["waiting_customer", "resolved", "open"]).default("waiting_customer") }),
  z.object({ action: z.literal("note"), body: z.string().trim().min(1).max(5000) }),
  z.object({ action: z.literal("status"), status: z.enum(SUPPORT_STATUSES) }),
  z.object({ action: z.literal("assign"), toMe: z.boolean() }),
  z.object({ action: z.literal("priority"), priority: z.enum(["normal", "high"]) }),
]);

export async function staffAction(actor: { id: string }, ticketId: string, raw: z.input<typeof staffActionSchema>, attachment: Attachment | null = null, db: Db = getDb()): Promise<TicketSummary> {
  const a = staffActionSchema.parse(raw);
  const found = await getTicketForStaff(ticketId, db);
  if (!found) throw new HttpError(404, "Ticket not found", "not_found");
  const file = a.action === "reply" || a.action === "note" ? checkAttachment(attachment) : null;
  await db.tx(async (tx) => {
    if (a.action === "reply") {
      await addMessage(tx, ticketId, { kind: "staff", userId: actor.id }, a.body, false, file);
      await tx.query("update support_tickets set status = $2, last_staff_at = now(), updated_at = now(), assigned_to = coalesce(assigned_to, $3) where id = $1", [ticketId, a.status, actor.id]);
    } else if (a.action === "note") {
      await addMessage(tx, ticketId, { kind: "staff", userId: actor.id }, a.body, true, file);
      await tx.query("update support_tickets set updated_at = now() where id = $1", [ticketId]);
    } else if (a.action === "status") {
      await tx.query("update support_tickets set status = $2, updated_at = now() where id = $1", [ticketId, a.status]);
      await addMessage(tx, ticketId, { kind: "system", userId: actor.id }, `Status changed to ${a.status.replace("_", " ")}.`, true, null);
    } else if (a.action === "assign") {
      await tx.query("update support_tickets set assigned_to = $2, updated_at = now() where id = $1", [ticketId, a.toMe ? actor.id : null]);
    } else {
      await tx.query("update support_tickets set priority = $2, updated_at = now() where id = $1", [ticketId, a.priority]);
    }
    await audit(tx, who(actor.id), `support.${a.action}`, { type: "support_ticket", id: ticketId }, a.action === "status" ? { status: a.status } : a.action === "priority" ? { priority: a.priority } : {});
  });
  const after = (await getTicketForStaff(ticketId, db))!.ticket;
  if (a.action === "reply") await notifyCustomer(after, a.body, db);
  return after;
}

/** An attachment, if the caller may see its ticket (owner, visitor link, or staff). Internal-note files are staff-only. */
export async function getAttachment(id: string, access: { staff: true } | { userId: string } | { token: string }, db: Db = getDb()): Promise<{ contentType: string; bytes: Buffer } | null> {
  const { rows } = await db.query<{ content_type: string; bytes: Buffer; user_id: string | null; access_token_hash: string | null; internal: boolean }>(
    `select a.content_type, a.bytes, t.user_id, t.access_token_hash, m.internal
       from support_attachments a join support_messages m on m.id = a.message_id join support_tickets t on t.id = m.ticket_id
      where a.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  const ok = "staff" in access || (!r.internal && ("userId" in access ? r.user_id === access.userId : r.access_token_hash === hashToken(access.token)));
  return ok ? { contentType: r.content_type, bytes: Buffer.from(r.bytes) } : null;
}

/** Read an optional file from multipart form data. */
export async function attachmentFromForm(form: FormData, field = "attachment"): Promise<Attachment | null> {
  const f = form.get(field);
  if (!f || typeof f !== "object" || !("arrayBuffer" in f) || (f as File).size === 0) return null;
  const file = f as File;
  if (file.size > MAX_ATTACHMENT_BYTES) throw new HttpError(400, "The file must be 3 MB or smaller.", "attachment_too_large");
  return { contentType: file.type, bytes: Buffer.from(await file.arrayBuffer()) };
}
