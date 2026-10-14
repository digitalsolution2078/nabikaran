import { z } from "zod";
import { getDb, type Db } from "../db";
import { audit } from "../core/audit";
import { HttpError } from "../core/errors";
import { webPrincipal } from "../core/principal";
import { normalizeNepalPhone } from "../phone";
import { getSetting } from "./settings";

/**
 * Business accounts: a dealer, insurance agent or consultancy keeps reminders
 * for its clients. A client reminder goes by SMS to the client's phone, signed
 * with the business name; the business pays from its own wallet and gets a
 * free app-notification copy. The business confirms each client agreed to
 * receive the SMS. Admins can block a number from all client reminders.
 */
export interface ClientRow {
  id: string;
  name: string;
  phone: string;
  note: string | null;
  status: "active" | "archived";
  createdAt: string;
  activeReminders: number;
  nextDue: string | null;
}

/** Shown at the end of each client SMS; plain letters so the SMS stays one segment. */
export const businessNameSchema = z
  .string()
  .trim()
  .min(2, "Use at least 2 characters")
  .max(20, "Use at most 20 characters")
  .regex(/^[A-Za-z0-9 .&'-]+$/, "Use English letters, digits, spaces and . & ' - only");

export const clientInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(7).max(20),
  note: z.string().trim().max(300).nullable().optional(),
});

const iso = (v: unknown) => (v ? (v instanceof Date ? v : new Date(String(v))).toISOString() : null);

export async function businessName(userId: string, db: Db = getDb()): Promise<string | null> {
  const { rows } = await db.query<{ business_name: string | null }>("select business_name from users where id = $1", [userId]);
  return rows[0]?.business_name ?? null;
}

/** Switch business tools on (with the name shown in client SMS) or off (null). */
export async function setBusinessName(userId: string, name: string | null, db: Db = getDb()): Promise<string | null> {
  if (name !== null) {
    const s = await getSetting("business", db);
    if (!s.enabled) throw new HttpError(403, "Business accounts are not available right now.", "business_disabled");
    const parsed = businessNameSchema.safeParse(name);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message, "invalid_business_name");
    name = parsed.data;
  } else {
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from renewal_items i join clients c on c.id = i.client_id where i.owner_user_id = $1 and i.status = 'active'",
      [userId],
    );
    if (rows[0].n > 0) throw new HttpError(409, "Delete or move your clients' reminders before turning business tools off.", "clients_have_reminders");
  }
  await db.query("update users set business_name = $2, updated_at = now() where id = $1", [userId, name]);
  await audit(db, webPrincipal({ id: userId, locale: "en" }), name ? "business.enabled" : "business.disabled", { type: "user", id: userId }, { name });
  return name;
}

async function requireBusiness(userId: string, db: Db): Promise<string> {
  const name = await businessName(userId, db);
  if (!name) throw new HttpError(403, "Turn on business tools in Settings first.", "business_required");
  return name;
}

function phoneOrThrow(input: string): string {
  const phone = normalizeNepalPhone(input);
  if (!phone) throw new HttpError(400, "Enter a valid Nepal mobile number (98…, 97… or 96…).", "invalid_phone");
  return phone;
}

async function assertNotBlocked(db: Db, phone: string): Promise<void> {
  const { rows } = await db.query("select 1 from blocked_recipients where phone_e164 = $1", [phone]);
  if (rows[0]) throw new HttpError(403, "This number has asked not to receive reminders from businesses.", "recipient_blocked");
}

export async function listClients(userId: string, opts: { q?: string; archived?: boolean } = {}, db: Db = getDb()): Promise<ClientRow[]> {
  const q = (opts.q ?? "").trim().slice(0, 60);
  const { rows } = await db.query<{ id: string; name: string; phone_e164: string; note: string | null; status: "active" | "archived"; created_at: unknown; active: number; next_due: unknown }>(
    `select c.id, c.name, c.phone_e164, c.note, c.status, c.created_at,
            (select count(*) from renewal_items i where i.client_id = c.id and i.status = 'active')::int as active,
            (select min(i.expiry_at_utc) from renewal_items i where i.client_id = c.id and i.status = 'active' and i.expiry_at_utc >= now()) as next_due
       from clients c
      where c.owner_user_id = $1 and c.status = $2
        and ($3 = '' or c.name ilike '%' || $3 || '%' or c.phone_e164 like '%' || regexp_replace($3, '[^0-9]', '', 'g') || '%')
      order by c.name limit 2000`,
    [userId, opts.archived ? "archived" : "active", q],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone_e164, note: r.note, status: r.status, createdAt: iso(r.created_at)!, activeReminders: r.active, nextDue: iso(r.next_due) }));
}

export async function getClient(userId: string, clientId: string, db: Db = getDb()): Promise<ClientRow> {
  const { rows } = await db.query<{ id: string }>("select id from clients where id = $1 and owner_user_id = $2", [clientId, userId]);
  if (!rows[0]) throw new HttpError(404, "Client not found", "not_found");
  const all = [...(await listClients(userId, {}, db)), ...(await listClients(userId, { archived: true }, db))];
  return all.find((c) => c.id === clientId)!;
}

export async function createClient(userId: string, input: z.infer<typeof clientInputSchema> & { consent: boolean }, db: Db = getDb()): Promise<ClientRow> {
  await requireBusiness(userId, db);
  if (!input.consent) throw new HttpError(400, "Confirm that the client agreed to receive reminder SMS.", "consent_required");
  const phone = phoneOrThrow(input.phone);
  await assertNotBlocked(db, phone);
  const { max_clients } = await getSetting("business", db);
  const { rows: n } = await db.query<{ n: number }>("select count(*)::int as n from clients where owner_user_id = $1 and status = 'active'", [userId]);
  if (n[0].n >= max_clients) throw new HttpError(409, `You can have up to ${max_clients} clients. Archive old clients or contact support.`, "client_limit");
  const { rows: dup } = await db.query("select 1 from clients where owner_user_id = $1 and phone_e164 = $2 and status = 'active'", [userId, phone]);
  if (dup[0]) throw new HttpError(409, "You already have a client with this number.", "client_exists");
  const { rows } = await db.query<{ id: string }>(
    "insert into clients (owner_user_id, name, phone_e164, note) values ($1, $2, $3, $4) returning id",
    [userId, input.name, phone, input.note || null],
  );
  await audit(db, webPrincipal({ id: userId, locale: "en" }), "client.create", { type: "client", id: rows[0].id }, { owner: userId });
  return getClient(userId, rows[0].id, db);
}

export async function updateClient(userId: string, clientId: string, input: z.infer<typeof clientInputSchema>, db: Db = getDb()): Promise<ClientRow> {
  await requireBusiness(userId, db);
  const phone = phoneOrThrow(input.phone);
  await assertNotBlocked(db, phone);
  const { rows: dup } = await db.query("select 1 from clients where owner_user_id = $1 and phone_e164 = $2 and status = 'active' and id <> $3", [userId, phone, clientId]);
  if (dup[0]) throw new HttpError(409, "You already have a client with this number.", "client_exists");
  const { rowCount } = await db.query(
    "update clients set name = $3, phone_e164 = $4, note = $5, updated_at = now() where id = $1 and owner_user_id = $2 and status = 'active'",
    [clientId, userId, input.name, phone, input.note || null],
  );
  if (!rowCount) throw new HttpError(404, "Client not found", "not_found");
  await audit(db, webPrincipal({ id: userId, locale: "en" }), "client.update", { type: "client", id: clientId }, { owner: userId });
  return getClient(userId, clientId, db);
}

/** Archive (hide) a client. Their reminders must be deleted or moved first. */
export async function archiveClient(userId: string, clientId: string, db: Db = getDb()): Promise<void> {
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from renewal_items where client_id = $1 and owner_user_id = $2 and status = 'active'", [clientId, userId]);
  if (rows[0].n > 0) throw new HttpError(409, "This client still has active reminders. Delete them first.", "client_has_reminders");
  const { rowCount } = await db.query("update clients set status = 'archived', updated_at = now() where id = $1 and owner_user_id = $2 and status = 'active'", [clientId, userId]);
  if (!rowCount) throw new HttpError(404, "Client not found", "not_found");
  await audit(db, webPrincipal({ id: userId, locale: "en" }), "client.archive", { type: "client", id: clientId }, { owner: userId });
}

/**
 * For reminders: the client must be the owner's own active client, business
 * tools on, number not blocked. Client reminders are sent by SMS (plus the
 * owner's free app copy): WhatsApp and email need the recipient's own opt-in.
 */
export async function assertClientReminder(tx: Db, userId: string, clientId: string | null | undefined, channels: string[]): Promise<void> {
  if (!clientId) return;
  await requireBusiness(userId, tx);
  const { rows } = await tx.query<{ phone_e164: string }>("select phone_e164 from clients where id = $1 and owner_user_id = $2 and status = 'active'", [clientId, userId]);
  if (!rows[0]) throw new HttpError(404, "Client not found", "client_not_found");
  await assertNotBlocked(tx, rows[0].phone_e164);
  if (!channels.includes("sms") || channels.some((c) => c !== "sms" && c !== "push")) {
    throw new HttpError(400, "Client reminders are sent by SMS to the client (you get a free app notification copy).", "client_sms_only");
  }
}

/** Find or create a client by phone (CSV import). */
export async function clientForImport(tx: Db, userId: string, name: string, phoneInput: string): Promise<string> {
  const phone = phoneOrThrow(phoneInput);
  const { rows } = await tx.query<{ id: string }>("select id from clients where owner_user_id = $1 and phone_e164 = $2 and status = 'active'", [userId, phone]);
  if (rows[0]) return rows[0].id;
  const c = await createClient(userId, { name: name || phone, phone, note: null, consent: true }, tx);
  return c.id;
}

// ---- admin ------------------------------------------------------------------

export async function businessStats(db: Db = getDb()): Promise<{ accounts: number; clients: number; reminders: number }> {
  const { rows } = await db.query<{ accounts: number; clients: number; reminders: number }>(
    `select (select count(*) from users where business_name is not null)::int as accounts,
            (select count(*) from clients where status = 'active')::int as clients,
            (select count(*) from renewal_items where client_id is not null and status = 'active')::int as reminders`,
  );
  return rows[0];
}

/** Admin user page: the account's business name and client count. */
export async function businessSummary(userId: string, db: Db = getDb()): Promise<{ name: string | null; clients: number; reminders: number }> {
  const { rows } = await db.query<{ name: string | null; clients: number; reminders: number }>(
    `select u.business_name as name,
            (select count(*) from clients c where c.owner_user_id = u.id and c.status = 'active')::int as clients,
            (select count(*) from renewal_items i where i.owner_user_id = u.id and i.client_id is not null and i.status = 'active')::int as reminders
       from users u where u.id = $1`,
    [userId],
  );
  return rows[0] ?? { name: null, clients: 0, reminders: 0 };
}

// ---- admin: numbers that must not receive client reminders -----------------

export async function listBlockedRecipients(db: Db = getDb()): Promise<Array<{ phone: string; reason: string | null; createdAt: string }>> {
  const { rows } = await db.query<{ phone_e164: string; reason: string | null; created_at: unknown }>("select phone_e164, reason, created_at from blocked_recipients order by created_at desc limit 500");
  return rows.map((r) => ({ phone: r.phone_e164, reason: r.reason, createdAt: iso(r.created_at)! }));
}

/** Block a number: future client reminders to it are cancelled and their credits returned. */
export async function blockRecipient(admin: { id: string; locale?: string }, phoneInput: string, reason: string | null, db: Db = getDb()): Promise<{ phone: string; cancelled: number }> {
  const phone = phoneOrThrow(phoneInput);
  return db.tx(async (tx) => {
    await tx.query("insert into blocked_recipients (phone_e164, reason, created_by) values ($1, $2, $3) on conflict (phone_e164) do update set reason = excluded.reason", [phone, reason, admin.id]);
    const { rows: jobs } = await tx.query<{ id: string }>(
      `select j.id from reminder_jobs j join renewal_items i on i.id = j.renewal_id join clients c on c.id = i.client_id
        where c.phone_e164 = $1 and j.status in ('planned','awaiting_credits','scheduled') for update of j`,
      [phone],
    );
    for (const j of jobs) {
      await tx.query("select wallet_release_for_job($1)", [j.id]);
      await tx.query("update reminder_jobs set status = 'cancelled', last_error = 'recipient blocked', updated_at = now() where id = $1", [j.id]);
    }
    await audit(tx, webPrincipal({ id: admin.id, locale: admin.locale ?? "en" }), "recipient.block", { type: "phone", id: phone }, { reason, cancelled: jobs.length });
    return { phone, cancelled: jobs.length };
  });
}

export async function unblockRecipient(admin: { id: string; locale?: string }, phoneInput: string, db: Db = getDb()): Promise<void> {
  const phone = phoneOrThrow(phoneInput);
  await db.query("delete from blocked_recipients where phone_e164 = $1", [phone]);
  await audit(db, webPrincipal({ id: admin.id, locale: admin.locale ?? "en" }), "recipient.unblock", { type: "phone", id: phone }, {});
}
