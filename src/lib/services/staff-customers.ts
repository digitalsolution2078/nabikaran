import { z } from "zod";
import { getDb, type Db } from "../db";
import { HttpError } from "../core/errors";
import { audit } from "../core/audit";
import { normalizeNepalPhone } from "../phone";
import { can, type Role } from "../auth/rbac";
import { getSmsProvider } from "../providers/sms";
import { readWallet } from "../core/wallet";
import { COUNTER_METHODS, counterTopup } from "./counter";
import { requestWalletAdjustment } from "./admin";
import { directAdjustment } from "./admin-console";

/**
 * Staff add a customer account (walk-in, phone call, a business signing up its
 * team) and optionally give it credits in the same step:
 *   paid — money received (cash, Khalti, Fonepay, bank…): a counter top-up with
 *          receipt and daily limit, same as the Counter page;
 *   free — complimentary credits: applied at once by a super admin, otherwise
 *          sent for a second admin's approval (two-person rule).
 * The customer later signs in with an SMS code on that number; nothing else is
 * needed. Every step is in the audit log, and users.created_by records who
 * added the account.
 */
export const staffCustomerSchema = z.object({
  phone: z.string().min(9).max(20),
  name: z.string().trim().max(60).nullable().default(null),
  email: z.string().trim().toLowerCase().email().max(120).nullable().default(null),
  locale: z.enum(["ne-NP", "en-NP"]).default("ne-NP"),
  credit: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({
      kind: z.literal("paid"),
      amountNpr: z.number().int().min(1).max(1000000),
      method: z.enum(COUNTER_METHODS),
      receipt: z.string().max(40).nullable().default(null),
      note: z.string().max(300).nullable().default(null),
    }),
    z.object({ kind: z.literal("free"), credits: z.number().int().min(1).max(100000), reason: z.string().trim().min(3).max(200) }),
  ]).default({ kind: "none" }),
  welcomeSms: z.boolean().default(false),
  idempotencyKey: z.string().min(8).max(64),
});
export type StaffCustomerInput = z.infer<typeof staffCustomerSchema>;

export interface StaffCustomerResult {
  customer: { id: string; phone: string; name: string | null; available: number };
  credit:
    | { kind: "none" }
    | { kind: "paid"; reference: string; credits: number; bonus: number }
    | { kind: "free"; status: "applied" | "pending"; credits: number }
    | { kind: "failed"; message: string };
  welcomeSms: "sent" | "failed" | "skipped";
}

/** What a staff role may do here, for the form. */
export function staffCustomerAbilities(role: Role | string | null | undefined) {
  return {
    create: can(role, "customers.create"),
    paid: can(role, "counter.topup"),
    freeDirect: can(role, "adjustments.direct"),
    freeRequest: can(role, "adjustments.request"),
  };
}

export async function createCustomerByStaff(actor: { id: string; role: string }, input: StaffCustomerInput, db: Db = getDb()): Promise<StaffCustomerResult> {
  const may = staffCustomerAbilities(actor.role);
  if (!may.create) throw new HttpError(403, "You cannot add customers.", "forbidden");
  if (input.credit.kind === "paid" && !may.paid) throw new HttpError(403, "Your role cannot take payments. Add the account without credit.", "forbidden");
  if (input.credit.kind === "free" && !may.freeDirect && !may.freeRequest) throw new HttpError(403, "Your role cannot give free credits.", "forbidden");
  const phone = normalizeNepalPhone(input.phone);
  if (!phone) throw new HttpError(400, "Enter a valid Nepali mobile number.", "invalid_phone");
  const name = input.name?.replace(/\s+/g, " ").trim() || null;

  const userId = await db.tx(async (tx) => {
    const { rows: existing } = await tx.query<{ id: string }>("select id from users where phone_e164 = $1", [phone]);
    if (existing[0]) throw new HttpError(409, "This number already has a Nabikaran account. Open it to add credits.", "customer_exists", { id: existing[0].id });
    if (input.email) {
      const { rows: e } = await tx.query("select 1 from users where lower(email) = $1", [input.email]);
      if (e[0]) throw new HttpError(409, "This email is already used by another account.", "email_taken");
    }
    const { rows } = await tx.query<{ id: string }>(
      "insert into users (phone_e164, display_name, email, locale, created_by) values ($1, $2, $3, $4, $5) returning id",
      [phone, name, input.email, input.locale, actor.id],
    );
    await tx.query("insert into wallets (user_id) values ($1) on conflict do nothing", [rows[0].id]);
    await audit(tx, { userId: actor.id, via: "web", scopes: [], locale: "en" }, "customer.created_by_staff", { type: "user", id: rows[0].id }, { credit: input.credit.kind, welcomeSms: input.welcomeSms });
    return rows[0].id;
  });

  // Credit is a separate step: if it is refused (e.g. daily counter limit), the account stays and staff see why.
  let credit: StaffCustomerResult["credit"] = { kind: "none" };
  try {
    if (input.credit.kind === "paid") {
      const c = input.credit;
      const r = await counterTopup(actor, { phone, amountNpr: c.amountNpr, method: c.method, receipt: c.receipt, note: c.note ?? "New account", idempotencyKey: input.idempotencyKey }, db);
      credit = { kind: "paid", reference: r.reference, credits: r.credits, bonus: r.bonus };
    } else if (input.credit.kind === "free") {
      const c = input.credit;
      const reason = `New account: ${c.reason}`;
      if (may.freeDirect) {
        await directAdjustment(actor.id, userId, c.credits, reason, `new-${input.idempotencyKey}`, db);
        credit = { kind: "free", status: "applied", credits: c.credits };
      } else {
        await requestWalletAdjustment(actor.id, userId, c.credits, reason, db);
        credit = { kind: "free", status: "pending", credits: c.credits };
      }
    }
  } catch (e) {
    credit = { kind: "failed", message: (e as Error).message };
  }

  let welcomeSms: StaffCustomerResult["welcomeSms"] = "skipped";
  if (input.welcomeSms) {
    const added = credit.kind === "paid" || (credit.kind === "free" && credit.status === "applied") ? credit.credits : 0;
    const text = input.locale === "en-NP"
      ? `Nabikaran: your account is ready${added ? ` with ${added} credits` : ""}. Sign in with this number at nabikaran.org to add renewal reminders.`
      : `Nabikaran: your account is ready${added ? ` (${added} credits)` : ""}. nabikaran.org ma yo number le login garnuhos ra renewal reminder rakhnuhos.`;
    try {
      welcomeSms = (await getSmsProvider().send({ to: phone, text, idempotencyKey: `welcome:${userId}` })).kind === "accepted" ? "sent" : "failed";
    } catch {
      welcomeSms = "failed";
    }
  }

  return { customer: { id: userId, phone, name, available: (await readWallet(userId, db)).available }, credit, welcomeSms };
}

/** The latest accounts staff added, with who added them. */
export async function recentStaffCustomers(limit = 10, db: Db = getDb()) {
  const { rows } = await db.query<{ id: string; phone_e164: string; display_name: string | null; created_at: string; staff: string | null; signed_in: boolean }>(
    `select u.id, u.phone_e164, u.display_name, u.created_at, coalesce(s.display_name, s.phone_e164) as staff, (u.phone_verified_at is not null) as signed_in
       from users u left join users s on s.id = u.created_by
      where u.created_by is not null order by u.created_at desc limit $1`,
    [limit],
  );
  return rows.map((r) => ({ id: r.id, phone: r.phone_e164, name: r.display_name, createdAt: new Date(r.created_at).toISOString(), staff: r.staff, signedIn: r.signed_in }));
}
