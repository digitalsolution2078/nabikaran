import { z } from "zod";
import { handle, json, parseBody, requireUser, HttpError, errorResponse } from "@/lib/http";
import { getDb } from "@/lib/db";
import { clearSessionCookie } from "@/lib/auth/session";
import { revokeAllForUserClient } from "@/lib/oauth/tokens";

export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    return json({ user });
  });
}

/** Profile: verified phone is read-only (FR-02); only display name and locale change here. */
export async function PATCH(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    const body = await parseBody(req, z.object({ displayName: z.string().trim().max(60).optional(), locale: z.enum(["ne-NP", "en-NP"]).optional() }));
    await getDb().query("update users set display_name = coalesce($2, display_name), locale = coalesce($3, locale), updated_at = now() where id = $1", [
      user.id, body.displayName ?? null, body.locale ?? null,
    ]);
    return json({ ok: true });
  });
}

/** Data export (FR-11): everything the user owns, as JSON. */
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    const { action } = await parseBody(req, z.object({ action: z.enum(["export", "delete"]) }));
    const db = getDb();
    if (action === "export") {
      const [renewals, jobs, ledger, orders, qr, consent] = await Promise.all([
        db.query("select * from renewal_items where owner_user_id = $1", [user.id]),
        db.query("select * from reminder_jobs where user_id = $1", [user.id]),
        db.query("select * from wallet_ledger where user_id = $1 order by created_at", [user.id]),
        db.query("select id, gateway, order_reference, amount_paisa, credits, status, created_at, paid_at from payment_orders where user_id = $1", [user.id]),
        db.query("select id, reference, amount_paisa, credits, status, payer_txn_ref, created_at, decided_at from manual_topup_requests where user_id = $1", [user.id]),
        db.query("select whatsapp_opt_in_at from users where id = $1", [user.id]),
      ]);
      return json({ exportedAt: new Date().toISOString(), user, whatsappOptInAt: consent.rows[0]?.whatsapp_opt_in_at ?? null, renewals: renewals.rows, jobs: jobs.rows, ledger: ledger.rows, orders: orders.rows, qrTopups: qr.rows });
    }
    // Account closure request: scheduled sends are cancelled and holds released; ledger/payment
    // records are retained for accounting (see /privacy). Unused prepaid credits are handled
    // under the published refund/closure policy, not deleted silently.
    const { rows } = await db.query<{ reserved: string; posted: string }>("select reserved_credits::text as reserved, posted_balance_credits::text as posted from wallets where user_id = $1", [user.id]);
    await db.tx(async (tx) => {
      const { rows: jobs } = await tx.query<{ id: string }>("select id from reminder_jobs where user_id = $1 and status in ('planned','awaiting_credits','scheduled')", [user.id]);
      for (const j of jobs) {
        await tx.query("select wallet_release_for_job($1)", [j.id]);
        await tx.query("update reminder_jobs set status = 'cancelled', last_error = 'account closed', updated_at = now() where id = $1", [j.id]);
      }
      await tx.query("update renewal_items set status = 'deleted', updated_at = now() where owner_user_id = $1", [user.id]);
      await tx.query("update users set status = 'closed', display_name = null, whatsapp_opt_in_at = null, updated_at = now() where id = $1", [user.id]);
      // Balance at closure (after releasing holds) is recorded for the refund policy (Terms §4–5).
      await tx.query("insert into audit_events (actor_user_id, action, target_type, target_id, json_detail_redacted) values ($1,'account.closed','user',$2,$3)", [
        user.id, user.id, JSON.stringify({ releasedReserved: Number(rows[0]?.reserved ?? 0), balanceAtClosure: Number(rows[0]?.posted ?? 0), cancelledJobs: jobs.length }),
      ]);
    });
    await revokeAllForUserClient(user.id, null, "account_closed");
    await clearSessionCookie();
    return json({ ok: true, balanceAtClosure: Number(rows[0]?.posted ?? 0), note: "Account closed. Scheduled reminders were cancelled. Unused credits are not refundable except under Terms §4." });
  });
}

export async function DELETE() {
  return errorResponse(new HttpError(405, "Use POST {action:'delete'}"));
}
