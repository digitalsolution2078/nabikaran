import { randomUUID } from "node:crypto";
import { getDb, type Db } from "../db";
import { env } from "../env";
import { getSmsProvider } from "../providers/sms";
import { renderReminder } from "../sms/templates";
import { renderWhatsApp } from "../whatsapp/templates";
import { getWhatsAppProvider } from "../providers/whatsapp";
import { whatsappAvailable } from "../whatsapp/availability";
import { getSetting } from "./settings";
import { BOOKED_COMMIT } from "./billing";
import { categorySmsName } from "../categories";
import { loadTemplates, loadWaTemplates, rolloverYearly } from "../core/reminders";
import { getActivePricing } from "../core/wallet";
import { MAX_SEND_ATTEMPTS, retryDelayMs, SCHEDULING_HORIZON_DAYS } from "../scheduler";

import { redactPhone } from "../phone";
import { pushReminders, type ReminderPush } from "./push";
import { getEmailProvider, textToHtml } from "../providers/email";
import { runDigests, runProNotices } from "./digest";

/**
 * Database-backed dispatcher (PRD §7). Runs every minute.
 *
 * Invariants:
 *  - a job is leased with FOR UPDATE SKIP LOCKED (jobs_claim_due)
 *  - every provider call is preceded by an sms_attempts row with a unique
 *    idempotency key; a crash between "attempt inserted" and "outcome
 *    recorded" leaves api_state = pending, and the stale-lease recovery
 *    marks the job unknown (reconcile, never resend)
 *  - the wallet is debited exactly once per accepted attempt via
 *    wallet_commit_for_job(idempotency_key)
 */
export interface DispatchSummary {
  claimed: number;
  submitted: number;
  failed: number;
  retried: number;
  unknown: number;
  skipped: number;
  recovered: number;
}

interface ClaimedJob {
  id: string;
  renewal_id: string;
  user_id: string;
  cycle_no: number;
  due_at_utc: string;
  attempts: number;
  estimated_credits: string | number;
  estimated_segments: string | number;
  channel?: string;
  lock_token: string;
}

export async function runDispatcher(db: Db = getDb(), now: Date = new Date()): Promise<DispatchSummary> {
  const provider = getSmsProvider();
  const summary: DispatchSummary = { claimed: 0, submitted: 0, failed: 0, retried: 0, unknown: 0, skipped: 0, recovered: 0 };

  const { rows: rec } = await db.query<{ jobs_recover_stale_leases: number }>("select jobs_recover_stale_leases()");
  summary.recovered = Number(rec[0]?.jobs_recover_stale_leases ?? 0);

  const token = randomUUID();
  const { rows: jobs } = await db.query<ClaimedJob>("select * from jobs_claim_due($1, $2, $3)", [env.dispatcher.batchSize, env.dispatcher.leaseSeconds, token]);
  summary.claimed = jobs.length;
  if (jobs.length === 0) return summary;

  const templates = await loadTemplates(db);
  const pricing = await getActivePricing(db, "sms");
  const hasWa = jobs.some((j) => j.channel === "whatsapp");
  const [waPricing, waTemplates, waSettings, waOk] = hasWa
    ? await Promise.all([getActivePricing(db, "whatsapp"), loadWaTemplates(db), getSetting("whatsapp", db), whatsappAvailable(db)])
    : [pricing, [], null, false];
  const waProvider = hasWa ? getWhatsAppProvider() : null;
  const hasEmail = jobs.some((j) => j.channel === "email");
  const [emailProvider, emailPricing] = hasEmail ? await Promise.all([getEmailProvider(db), getActivePricing(db, "email")]) : [null, pricing];

  const pushes: ReminderPush[] = [];
  for (const job of jobs) {
    // Atomic pre-send verification inside a transaction: renewal active, phone verified,
    // reservation active, no accepted/pending attempt, due.
    const pre = await db.tx(async (tx) => {
      const { rows } = await tx.query<{
        job_status: string; due_at_utc: string; renewal_status: string; label: string; category: string; expiry_at_utc: string; cycle_no: number; job_cycle: number;
        phone_e164: string; phone_verified_at: string | null; locale: string; user_status: string; reservation_status: string | null; held: string | null;
        email: string | null; email_verified_at: string | null;
        prior: number;
      }>(
        `select j.status as job_status, j.due_at_utc, i.status as renewal_status, i.label, i.category, i.expiry_at_utc, i.cycle_no, j.cycle_no as job_cycle,
                u.phone_e164, u.phone_verified_at, u.locale, u.status as user_status, u.email, u.email_verified_at, r.status as reservation_status, r.held_credits::text as held,
                (select count(*) from sms_attempts a where a.job_id = j.id and a.api_state in ('pending','accepted'))::int as prior
           from reminder_jobs j
           join renewal_items i on i.id = j.renewal_id
           join users u on u.id = j.user_id
           left join credit_reservations r on r.reminder_job_id = j.id
          where j.id = $1 and j.lock_token = $2 for update of j`,
        [job.id, token],
      );
      const s = rows[0];
      if (!s) return { ok: false as const, reason: "lease lost" };
      const fail = async (status: string, reason: string, release = true) => {
        if (release) await tx.query("select wallet_release_for_job($1)", [job.id]);
        await tx.query("update reminder_jobs set status = $2, last_error = $3, lock_at = null, lock_token = null, updated_at = now() where id = $1", [job.id, status, reason]);
        return { ok: false as const, reason };
      };
      if (s.renewal_status !== "active" || s.cycle_no !== s.job_cycle) return fail("cancelled", "renewal not active or superseded");
      if (s.user_status !== "active" || !s.phone_verified_at) return fail("cancelled", "destination not verified");
      if (s.prior > 0) return fail("unknown", "prior attempt exists; reconcile", false);
      if (s.reservation_status !== "active") return fail("awaiting_credits", "no active reservation");
      if (new Date(s.due_at_utc).getTime() > now.getTime()) return fail("scheduled", "not due", false);
      const isWa = job.channel === "whatsapp";
      // WhatsApp switched off (or provider missing) after scheduling: return the credits.
      if (isWa && (!waOk || !waProvider)) return fail("failed", "WhatsApp is not available; credits returned");
      const isEmail = job.channel === "email";
      if (isEmail && !emailProvider) return fail("failed", "Email is not set up; credits returned");
      if (isEmail && (!s.email || !s.email_verified_at)) return fail("failed", "No verified email on the account; credits returned");

      const attemptNo = job.attempts + 1;
      const idempotencyKey = `${isWa ? "wa" : isEmail ? "email" : "sms"}:${job.id}:${attemptNo}`;
      await tx.query(
        "insert into sms_attempts (job_id, attempt_no, provider, idempotency_key, api_state, channel) values ($1,$2,$3,$4,'pending',$5)",
        [job.id, attemptNo, isWa ? waProvider!.name : isEmail ? emailProvider!.name : provider.name, idempotencyKey, job.channel ?? "sms"],
      );
      await tx.query("update reminder_jobs set attempts = $2, updated_at = now() where id = $1", [job.id, attemptNo]);
      const base = { label: s.label, fallbackLabel: categorySmsName(s.category), expiryAtUtc: new Date(s.expiry_at_utc), dueAtUtc: new Date(s.due_at_utc), locale: s.locale, category: s.category };
      if (isWa) {
        const w = renderWhatsApp(base, waTemplates);
        return { ok: true as const, attemptNo, idempotencyKey, to: s.phone_e164, text: w.preview, estimatedSegments: 1, wa: w, email: null };
      }
      const rendered = renderReminder(base, templates);
      if (isEmail) {
        return { ok: true as const, attemptNo, idempotencyKey, to: s.email!, text: rendered.body, estimatedSegments: 1, wa: null, email: { subject: `Reminder: ${s.label}`.slice(0, 120) } };
      }
      return { ok: true as const, attemptNo, idempotencyKey, to: s.phone_e164, text: rendered.body, estimatedSegments: rendered.estimate.segments, wa: null, email: null };
    });

    if (!pre.ok) {
      summary.skipped++;
      continue;
    }
    // Free web push alongside the message (once per occurrence, sent after the loop).
    pushes.push({ userId: job.user_id, renewalId: job.renewal_id, occurrenceKey: `${job.renewal_id}:${job.cycle_no}:${new Date(job.due_at_utc).toISOString()}`, body: pre.text });

    // Exactly one provider call per attempt.
    const outcome = pre.email
      ? await emailProvider!.send({
          to: pre.to,
          subject: pre.email.subject,
          text: pre.text,
          html: textToHtml(pre.text, { href: `${env.appUrl.replace(/\/$/, "")}/renewals/${job.renewal_id}`, label: "Open in Nabikaran" }),
          // Same key on every retry of this message: Resend never sends it twice.
          idempotencyKey: `email-${job.id}`,
        })
      : pre.wa
      ? await waProvider!.send({
          to: pre.to,
          phoneNumberId: waSettings?.phone_number_id ?? "",
          templateName: pre.wa.templateName,
          language: pre.wa.language,
          params: pre.wa.params,
          idempotencyKey: pre.idempotencyKey,
        })
      : await provider.send({ to: pre.to, text: pre.text, idempotencyKey: pre.idempotencyKey });
    const channelPrice = pre.wa ? waPricing.creditsPerUnit : pre.email ? emailPricing.creditsPerUnit : pricing.creditsPerUnit;
    const event = (q: Db, what: string, detail: Record<string, unknown>) =>
      pre.wa
        ? q.query("insert into audit_events (actor_via, action, target_type, target_id, json_detail_redacted) values ('worker',$1,'reminder_job',$2,$3)", [`whatsapp.message.${what}`, job.id, JSON.stringify(detail)])
        : Promise.resolve();

    await db.tx(async (tx) => {
      if (outcome.kind === "accepted") {
        const reported = outcome.units && outcome.units > 0 ? outcome.units : pre.estimatedSegments;
        await tx.query(
          "update sms_attempts set api_state = 'accepted', provider_message_id = $2, reported_units = $3, response_at = now() where idempotency_key = $1",
          [pre.idempotencyKey, outcome.providerMessageId, reported],
        );
        // The customer pays exactly what was quoted and reserved: the job's stored
        // segment count × its booked price. A provider count that differs is kept
        // in sms_attempts.reported_units for admin reconciliation, not billed.
        const quoted = Number(job.estimated_segments) || pre.estimatedSegments;
        if (reported !== quoted) console.warn(`[dispatcher] provider billed ${reported} unit(s) for job ${job.id}; quoted ${quoted}`);
        await tx.query(BOOKED_COMMIT, [job.id, quoted, channelPrice, `debit:${pre.idempotencyKey}`]);
        await tx.query("update reminder_jobs set status = 'submitted', lock_at = null, lock_token = null, last_error = null, updated_at = now() where id = $1", [job.id]);
        summary.submitted++;
        await event(tx, "submitted", { providerMessageId: outcome.providerMessageId });
        return;
      }
      if (outcome.kind === "rejected") {
        await tx.query("update sms_attempts set api_state = 'rejected', error_text = $2, response_at = now() where idempotency_key = $1", [pre.idempotencyKey, outcome.reason]);
        if (outcome.transient && pre.attemptNo < MAX_SEND_ATTEMPTS) {
          const next = new Date(now.getTime() + retryDelayMs(pre.attemptNo)).toISOString();
          await tx.query("update reminder_jobs set status = 'scheduled', next_attempt_at = $2, lock_at = null, lock_token = null, last_error = $3, updated_at = now() where id = $1", [
            job.id, next, outcome.reason,
          ]);
          summary.retried++;
        } else {
          await tx.query("select wallet_release_for_job($1)", [job.id]);
          await tx.query("update reminder_jobs set status = 'failed', lock_at = null, lock_token = null, last_error = $2, updated_at = now() where id = $1", [job.id, outcome.reason]);
          summary.failed++;
          await event(tx, "failed", { reason: outcome.reason, refunded: "reservation released" });
        }
        return;
      }
      await tx.query("update sms_attempts set api_state = 'unknown', error_text = $2, response_at = now() where idempotency_key = $1", [pre.idempotencyKey, outcome.reason]);
      await tx.query("update reminder_jobs set status = 'unknown', lock_at = null, lock_token = null, last_error = $2, updated_at = now() where id = $1", [job.id, outcome.reason]);
      summary.unknown++;
      await event(tx, "unknown", { reason: outcome.reason });
      console.warn(`[dispatch] unknown outcome job=${job.id} to=${redactPhone(pre.to)}: ${outcome.reason}`);
    });
  }
  if (pushes.length) await pushReminders(pushes, db);
  return summary;
}

export interface ReconcileSummary {
  reportsPolled: number;
  delivered: number;
  failed: number;
  unknownResolved: number;
  promotedPlanned: number;
  rolledYearly: number;
  digests?: number;
  proNotices?: number;
}

/**
 * Reconciler (PRD §7/§8): poll provider reports for submitted messages,
 * resolve "unknown" attempts via client reference lookup (never resend),
 * and promote planned jobs that have entered the scheduling horizon.
 */
export async function runReconciler(db: Db = getDb(), now: Date = new Date()): Promise<ReconcileSummary> {
  const provider = getSmsProvider();
  const pricing = await getActivePricing(db);
  const out: ReconcileSummary = { reportsPolled: 0, delivered: 0, failed: 0, unknownResolved: 0, promotedPlanned: 0, rolledYearly: 0 };

  // 1. Delivery reports for submitted jobs (last 3 days).
  const { rows: submitted } = await db.query<{ job_id: string; provider_message_id: string; idempotency_key: string; reported_units: number | null }>(
    `select a.job_id, a.provider_message_id, a.idempotency_key, a.reported_units from sms_attempts a join reminder_jobs j on j.id = a.job_id
      where a.channel = 'sms' and j.status = 'submitted' and a.api_state = 'accepted' and a.provider_message_id is not null and a.request_at > now() - interval '3 days' limit 500`,
  );
  if (submitted.length) {
    const reports = await provider.report(submitted.map((s) => s.provider_message_id));
    out.reportsPolled = reports.length;
    // Diagnostics: if the provider returned nothing usable, record a sample so operators
    // can confirm the delivery-report API with the provider (shown on the admin overview).
    if (reports.length > 0 && reports.every((r) => r.status === "unknown")) {
      await db.query("insert into audit_events (actor_via, action, json_detail_redacted) values ('worker','sms.report_unavailable',$1)", [
        JSON.stringify({ polled: reports.length, sample: JSON.stringify(reports[0].raw ?? null).slice(0, 300) }),
      ]);
    }
    for (const r of reports) {
      const a = submitted.find((s) => s.provider_message_id === r.providerMessageId);
      if (!a) continue;
      if (r.status === "delivered" || r.status === "failed") {
        await db.query("update sms_attempts set reported_status = $2, reported_units = coalesce($3, reported_units) where idempotency_key = $1", [a.idempotency_key, r.status, r.units ?? null]);
        await db.query("update sms_attempts set delivered_at = case when $2 = 'delivered' then coalesce(delivered_at, now()) else delivered_at end where idempotency_key = $1", [a.idempotency_key, r.status]);
        await db.query("update reminder_jobs set status = $2, updated_at = now() where id = $1 and status = 'submitted'", [a.job_id, r.status]);
        // Refund policy (services/billing.ts): a provider-reported failure reverses the charge.
        if (r.status === "failed") {
          const { rows: rev } = await db.query<{ wallet_reverse_debit_for_job: string }>("select wallet_reverse_debit_for_job($1, $2)", [a.job_id, `debit:${a.idempotency_key}`]);
          if (Number(rev[0]?.wallet_reverse_debit_for_job ?? 0) !== 0) {
            await db.query("update sms_attempts set refunded_at = now() where idempotency_key = $1", [a.idempotency_key]);
            await db.query("insert into audit_events (actor_via, action, target_type, target_id, json_detail_redacted) values ('worker','sms.failed_refunded','reminder_job',$1,$2)", [
              a.job_id, JSON.stringify({ credits: Number(rev[0].wallet_reverse_debit_for_job) }),
            ]);
          }
        }
        // A unit-count difference is logged for manual review (the customer pays the quote).
        if (r.units !== undefined && a.reported_units !== null && r.units !== a.reported_units) {
          await db.query("insert into audit_events (action, target_type, target_id, json_detail_redacted) values ('sms.unit_mismatch','reminder_job',$1,$2)", [
            a.job_id, JSON.stringify({ charged_units: a.reported_units, reported_units: r.units }),
          ]);
        }
        if (r.status === "delivered") out.delivered++;
        else out.failed++;
      }
    }
  }

  // 2. Unknown attempts: ask the provider whether our client reference was accepted.
  const { rows: unknowns } = await db.query<{ job_id: string; idempotency_key: string; attempt_no: number; estimated_segments: number }>(
    `select a.job_id, a.idempotency_key, a.attempt_no, j.estimated_segments from sms_attempts a join reminder_jobs j on j.id = a.job_id
      where a.channel = 'sms' and j.status = 'unknown' and a.api_state in ('unknown','pending') limit 200`,
  );
  for (const u of unknowns) {
    if (!provider.findByClientRef) continue; // manual action remains required
    const found = await provider.findByClientRef(u.idempotency_key);
    await db.tx(async (tx) => {
      if (found) {
        const units = found.units && found.units > 0 ? found.units : u.estimated_segments;
        const quoted = Number(u.estimated_segments) || units;
        await tx.query("update sms_attempts set api_state = 'accepted', provider_message_id = coalesce(provider_message_id, $2), reported_units = $3, reported_status = $4, response_at = now() where idempotency_key = $1", [
          u.idempotency_key, found.providerMessageId, units, found.status,
        ]);
        await tx.query(BOOKED_COMMIT, [u.job_id, quoted, pricing.creditsPerUnit, `debit:${u.idempotency_key}`]);
        await tx.query("update reminder_jobs set status = $2, last_error = null, updated_at = now() where id = $1", [u.job_id, found.status === "delivered" ? "delivered" : "submitted"]);
      } else {
        // Provider has no record: the request never landed. Safe to retry as a new attempt.
        await tx.query("update sms_attempts set api_state = 'rejected', error_text = 'not found at provider during reconciliation' where idempotency_key = $1", [u.idempotency_key]);
        if (u.attempt_no < MAX_SEND_ATTEMPTS) {
          await tx.query("update reminder_jobs set status = 'scheduled', next_attempt_at = $2, updated_at = now() where id = $1", [u.job_id, new Date(now.getTime() + retryDelayMs(u.attempt_no)).toISOString()]);
        } else {
          await tx.query("select wallet_release_for_job($1)", [u.job_id]);
          await tx.query("update reminder_jobs set status = 'failed', last_error = 'retries exhausted', updated_at = now() where id = $1", [u.job_id]);
        }
      }
    });
    out.unknownResolved++;
  }

  // 2b. WhatsApp attempts with an unknown outcome and no webhook for 6 hours: treat as not
  //     sent and return the credits (Meta echoes our key in webhooks, so a late "sent"
  //     would still be matched and charged by the webhook handler).
  const { rows: staleWa } = await db.query<{ job_id: string; idempotency_key: string }>(
    `select a.job_id, a.idempotency_key from sms_attempts a join reminder_jobs j on j.id = a.job_id
      where a.channel = 'whatsapp' and j.status = 'unknown' and a.api_state in ('unknown','pending') and a.request_at < $1 limit 200`,
    [new Date(now.getTime() - 6 * 3600_000).toISOString()],
  );
  for (const w of staleWa) {
    await db.tx(async (tx) => {
      await tx.query("select wallet_release_for_job($1)", [w.job_id]);
      await tx.query("update sms_attempts set api_state = 'rejected', error_text = 'no confirmation from Meta within 6 hours' where idempotency_key = $1", [w.idempotency_key]);
      await tx.query("update reminder_jobs set status = 'failed', last_error = 'no confirmation from Meta within 6 hours; credits returned', updated_at = now() where id = $1", [w.job_id]);
      await tx.query("insert into audit_events (actor_via, action, target_type, target_id) values ('worker','whatsapp.message.failed','reminder_job',$1)", [w.job_id]);
    });
    out.unknownResolved++;
  }

  // 3. Promote planned jobs now inside the horizon.
  const { rows: planned } = await db.query<{ id: string }>(
    "select id from reminder_jobs where status = 'planned' and due_at_utc <= $1 order by due_at_utc limit 500",
    [new Date(now.getTime() + SCHEDULING_HORIZON_DAYS * 86_400_000).toISOString()],
  );
  for (const p of planned) {
    await db.query("select wallet_reserve_for_job($1)", [p.id]);
    out.promotedPlanned++;
  }

  // 4. Yearly reminders (birthdays, anniversaries) move to next year's date.
  out.rolledYearly = (await rolloverYearly(db, now)).rolled;

  // 5. Pro: email summaries and "Pro ends soon" notices (free, best effort).
  out.digests = await runDigests(db, now).catch((e) => { console.warn(`[digest] ${(e as Error).message}`); return 0; });
  out.proNotices = await runProNotices(db, now).catch((e) => { console.warn(`[pro-notice] ${(e as Error).message}`); return 0; });
  return out;
}

/** Health signal for alerting: minutes since the last dispatcher run (PRD §11). */
export async function recordHeartbeat(name: string, db: Db = getDb()) {
  await db.query(
    "insert into audit_events (action, target_type, target_id, json_detail_redacted) values ('worker.heartbeat', 'worker', $1, '{}'::jsonb)",
    [name],
  );
}
