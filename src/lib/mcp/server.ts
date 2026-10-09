import { env } from "../env";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getDb } from "../db";
import { audit } from "../core/audit";
import { HttpError, RateLimitError, ScopeError } from "../core/errors";
import { principalSubject, type Principal } from "../core/principal";
import { checkRateLimit, countEvent } from "../core/rate-limit";
import { getAccount } from "../core/account";
import { getWalletSummary } from "../core/wallet";
import { listReminders, setReminderStatus, CATEGORIES } from "../core/reminders";
import { prepareReminderAction, confirmPreparedAction } from "../core/prepared-actions";
import { MAX_OFFSET_MINUTES } from "../scheduler";

/**
 * MCP tool surface (docs/MCP_ARCHITECTURE.md §6). Phase 2: read tools.
 *
 * Identity comes ONLY from `extra.authInfo.extra.principal`, which the HTTP
 * handler sets after validating the bearer token. No tool accepts a user id.
 * Scope checks live in core; this layer adds per-token rate limits, audit and
 * error mapping.
 */
export const MCP_SERVER_INFO = { name: "nabikaran", version: "0.2.0" } as const;
export const TOOL_RATE_LIMIT = { bucket: "mcp:call", limit: 60, windowSeconds: 60 } as const;
export const PREPARE_RATE_LIMIT = { bucket: "mcp:prepare", limit: 20, windowSeconds: 600 } as const;
export const MAX_REMINDERS_PER_USER = 200;

export function principalFromAuthInfo(authInfo: AuthInfo | undefined): Principal | null {
  const p = authInfo?.extra?.principal as Principal | undefined;
  return p && p.via === "mcp" && typeof p.userId === "string" ? p : null;
}

function text(t: string): CallToolResult["content"][number] {
  return { type: "text", text: t };
}

function ok(summary: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [text(summary)], structuredContent: structured };
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return { isError: true, content: [text(`${code}: ${message}`)], structuredContent: { error: code, message, ...extra } };
}

/** Common wrapper: resolve principal, rate-limit, run, audit, map errors. */
async function run(tool: string, extra: { authInfo?: AuthInfo }, fn: (p: Principal) => Promise<CallToolResult>): Promise<CallToolResult> {
  const p = principalFromAuthInfo(extra.authInfo);
  if (!p) return fail("unauthenticated", "A valid Nabikaran access token is required.");
  const db = getDb();
  try {
    await checkRateLimit(db, principalSubject(p), TOOL_RATE_LIMIT);
    const result = await fn(p);
    await audit(db, p, `mcp.${tool}`, null, { ok: !result.isError });
    await countEvent(db, result.isError ? "mcp:tool_error" : "mcp:tool_ok");
    return result;
  } catch (e) {
    if (e instanceof RateLimitError) return fail("rate_limited", `Too many requests. Retry after ${e.retryAfterSeconds}s.`, { retry_after_seconds: e.retryAfterSeconds });
    if (e instanceof ScopeError) {
      await audit(db, p, `mcp.${tool}`, null, { ok: false, error: "insufficient_scope", scope: e.scope });
      return fail("insufficient_scope", `This connection was not granted the "${e.scope}" permission. Reconnect Nabikaran and allow it.`, { required_scope: e.scope });
    }
    if (e instanceof HttpError) {
      await audit(db, p, `mcp.${tool}`, null, { ok: false, error: e.code ?? e.status });
      return fail(e.code ?? "error", e.message, e.code === "insufficient_credits" ? { ...e.detail, top_up_url: `${env.appUrl}/wallet` } : e.detail);
    }
    console.error(`[mcp] ${tool} failed`, e);
    await countEvent(db, "mcp:tool_error");
    return fail("internal_error", "Something went wrong on Nabikaran's side. Please try again.");
  }
}

export function createMcpServer(): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions: [
      "Nabikaran sends SMS renewal reminders to the user's verified Nepal mobile number.",
      "Credits: 1 credit = NPR 1; each SMS segment costs the rate shown by get_credit_balance.",
      "Top-ups happen only on the website (use top_up_url). Reminders are only ever sent to the user's own verified phone.",
      "Dates: Nepal time (Asia/Kathmandu). Both Gregorian (AD) and Bikram Sambat (BS) are returned; always show the user both when they matter.",
    ].join(" "),
  });

  server.registerTool(
    "get_account",
    {
      title: "Get account",
      description: "The connected Nabikaran account: display name, masked phone number that receives reminders, language and time zone.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) =>
      run("get_account", extra, async (p) => {
        const a = await getAccount(p);
        return ok(`Account for ${a.phoneMasked}${a.displayName ? ` (${a.displayName})` : ""}, language ${a.locale}, time zone ${a.timezone}.`, {
          display_name: a.displayName,
          phone_masked: a.phoneMasked,
          phone_verified: a.phoneVerified,
          locale: a.locale,
          timezone: a.timezone,
          member_since: a.memberSince,
          connected_client: { id: p.clientId, scopes: p.scopes },
        });
      }),
  );

  server.registerTool(
    "get_credit_balance",
    {
      title: "Get credit balance",
      description: "Prepaid SMS credit balance: available, reserved for scheduled reminders, and total. Includes the price per SMS segment and the website link to top up.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) =>
      run("get_credit_balance", extra, async (p) => {
        const w = await getWalletSummary(p);
        return ok(`${w.available} credits available (${w.reserved} reserved, ${w.posted} total). ${w.creditsPerSmsSegment} credits per SMS segment. Top up at ${w.topUpUrl}.`, {
          available_credits: w.available,
          reserved_credits: w.reserved,
          total_credits: w.posted,
          credit_value: w.creditValue,
          credits_per_sms_segment: w.creditsPerSmsSegment,
          pricing_version: w.pricingVersion,
          top_up_url: w.topUpUrl,
          note: "Top-ups are completed on the website. Credits never expire while the account is active.",
        });
      }),
  );

  server.registerTool(
    "list_reminders",
    {
      title: "List reminders",
      description: "List the user's renewal reminders with expiry dates (UTC, Nepal time, AD and BS) and the status of each scheduled SMS. Paginated.",
      inputSchema: {
        status: z.enum(["active", "paused", "cancelled", "all"]).default("active").describe("Filter by renewal status."),
        category: z.enum(CATEGORIES).optional().describe("Filter by document category."),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z.string().max(200).optional().describe("Opaque cursor from a previous call's next_cursor."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      run("list_reminders", extra, async (p) => {
        const { reminders, nextCursor } = await listReminders(p, { status: args.status, category: args.category, limit: args.limit, cursor: args.cursor ?? null });
        const lines = reminders.map((r) => `• ${r.label} (${r.category}) expires ${r.expiry.local} NPT${r.expiry.bs ? ` / BS ${r.expiry.bs.display}` : ""} — ${r.status}, ${r.jobs.length} reminder(s)`);
        return ok(reminders.length ? lines.join("\n") : "No reminders match.", {
          reminders: reminders.map((r) => ({
            id: r.id,
            label: r.label,
            category: r.category,
            status: r.status,
            cycle_no: r.cycleNo,
            expiry_at_utc: r.expiry.utc,
            expiry_local: `${r.expiry.local} NPT`,
            expiry_ad: r.expiry.ad,
            expiry_bs: r.expiry.bs?.date ?? null,
            expiry_bs_display: r.expiry.bs?.display ?? null,
            family_member_label: r.familyMemberLabel,
            jobs: r.jobs.map((j) => ({ id: j.id, offset_minutes: j.offsetMinutes, due_local: `${j.due.local} NPT`, due_at_utc: j.due.utc, status: j.status, estimated_credits: j.estimatedCredits })),
          })),
          next_cursor: nextCursor,
        });
      }),
  );

  // ---------------------------------------------------------------------------
  // Write tools (Phase 3): two-step prepare → confirm. Confirm only RESERVES
  // credits; the dispatcher charges on provider accept (docs §7).
  // ---------------------------------------------------------------------------
  const expirySchema = z.object({
    calendar: z.enum(["AD", "BS"]).describe("AD = Gregorian, BS = Bikram Sambat (Nepali calendar)."),
    date: z.string().min(8).max(12).describe("YYYY-MM-DD in the chosen calendar."),
    local_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("09:00").describe("Expiry time in Nepal time (HH:MM). Default 09:00."),
    source: z.enum(["user_typed", "extracted_from_image", "inferred"]).default("user_typed").describe("Where the date came from. Anything but user_typed requires explicit user confirmation."),
    user_confirmed: z.boolean().default(false).describe("Set true only after the user has explicitly confirmed the resolved date shown by a previous prepare_reminder call."),
  });

  server.registerTool(
    "prepare_reminder",
    {
      title: "Prepare a reminder (preview)",
      description:
        "Step 1 of 2. Validates the reminder, renders the exact message text per channel (SMS / WhatsApp), cost in credits and send times, and returns a prepared_id (valid 15 minutes). " +
        "You MUST show confirmation_prompt (message text, channel, AD/BS date, schedule, cost) to the user and get their explicit approval before confirm_reminder. This tool cannot top up the wallet or message any other number. " +
        "Nothing is reserved yet. If requires_user_confirmation is true (BS date, or a date read from an image / inferred), show confirmation_prompt to the user and, once they agree, call prepare_reminder again with expiry.user_confirmed=true, then confirm_reminder. " +
        "Pass reminder_id to prepare an edit of an existing reminder. Never send image bytes; send the structured fields the user confirmed.",
      inputSchema: {
        reminder_id: z.string().uuid().optional().describe("Existing reminder to update; omit to create."),
        category: z.enum(CATEGORIES),
        label: z.string().min(1).max(80).describe("Short name shown in the SMS, e.g. 'Ba 2 Pa 1234 Bluebook'."),
        expiry: expirySchema,
        offsets_minutes: z.array(z.number().int().min(0).max(MAX_OFFSET_MINUTES)).min(1).max(20).describe("When to send, in minutes before expiry. Presets: 43200 (30d), 21600 (15d), 10080 (7d), 4320 (3d), 1440 (1d), 0 (on the day)."),
        family_member_label: z.string().max(60).nullable().optional().describe("Optional owner label; SMS still goes to the account holder's phone."),
        notes: z.string().max(500).nullable().optional(),
        channels: z.array(z.enum(["sms", "whatsapp"])).min(1).max(2).optional().describe("Delivery channels; default SMS. WhatsApp works only if the user enabled it on the website (assistants cannot give WhatsApp consent). Messages always go to the account holder's own verified number."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      run("prepare_reminder", extra, async (p) => {
        const db = getDb();
        await checkRateLimit(db, `user:${p.userId}`, PREPARE_RATE_LIMIT);
        if (!args.reminder_id) {
          const { rows } = await db.query<{ n: string }>("select count(*)::text as n from renewal_items where owner_user_id = $1 and status <> 'deleted'", [p.userId]);
          if (Number(rows[0].n) >= MAX_REMINDERS_PER_USER) return fail("limit_reached", `Maximum ${MAX_REMINDERS_PER_USER} reminders per account.`);
        }
        const r = await prepareReminderAction(p, args, db);
        const pv = r.preview;
        const summary = `${r.requiresUserConfirmation ? "NEEDS DATE CONFIRMATION. " : ""}Show this to the user and get an explicit yes before confirm_reminder: ${r.confirmationPrompt} prepared_id ${r.preparedId}.`;
        return ok(summary, {
          prepared_id: r.preparedId,
          kind: r.kind,
          expires_at: r.expiresAt,
          resolved_expiry: { utc: pv.expiry.utc, local: `${pv.expiry.local} NPT`, ad: pv.expiry.ad, bs: pv.expiry.bs?.date ?? null, bs_display: pv.expiry.bs?.display ?? null },
          channels: pv.channels,
          cost_by_channel: pv.byChannel,
          schedule: pv.lines.map((l) => ({ channel: l.channel, offset_minutes: l.offsetMinutes, send_local: `${l.due.local} NPT`, send_at_utc: l.due.utc, message_text: l.smsText, sms_text: l.smsText, whatsapp_template: l.whatsappTemplate ?? null, segments: l.segments, encoding: l.encoding, credits: l.credits, horizon: l.horizon })),
          total_credits: pv.totalCredits,
          reserved_on_confirm: pv.reservedOnConfirmCredits,
          available_credits: pv.wallet.available,
          shortfall_credits: pv.shortfallCredits,
          credits_per_sms_segment: pv.creditsPerUnit,
          warnings: r.warnings,
          requires_user_confirmation: r.requiresUserConfirmation,
          confirmation_prompt: r.confirmationPrompt,
          expected_expiry_ad: pv.expiry.ad,
        });
      }),
  );

  server.registerTool(
    "confirm_reminder",
    {
      title: "Confirm a prepared reminder",
      description:
        "Step 2 of 2. Creates (or updates) the reminder from a prepared_id and reserves the credits shown in the preview. Safe to retry with the same idempotency_key. " +
        "expected_expiry_ad must be the resolved Gregorian date returned by prepare_reminder — this proves the date was shown to the user. If the wallet cannot cover every SMS the reminder is NOT saved: the tool returns insufficient_credits with the shortfall, and the user must top up on the website first.",
      inputSchema: {
        prepared_id: z.string().uuid(),
        expected_expiry_ad: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("The resolved_expiry.ad value from prepare_reminder."),
        idempotency_key: z.string().min(1).max(64).describe("Client-generated unique key for this confirmation; reuse it on retry."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      run("confirm_reminder", extra, async (p) => {
        const r = await confirmPreparedAction(p, { preparedId: args.prepared_id, expectedExpiryAd: args.expected_expiry_ad, idempotencyKey: args.idempotency_key });
        const w = await getWalletSummary(p);
        const text = r.funding.status === "reserved"
          ? `Reminder "${r.reminder.label}" ${r.replayed ? "already " : ""}scheduled: ${r.reminder.jobs.length} SMS, ${r.reservedCredits} credits reserved.`
          : `Reminder "${r.reminder.label}" saved but ${r.funding.shortfallCredits} more credits are needed; it will be scheduled automatically after a top-up at ${w.topUpUrl}.`;
        return ok(text, { reminder: reminderOut(r.reminder), reserved_credits: r.reservedCredits, funding: { status: r.funding.status, shortfall_credits: r.funding.shortfallCredits, top_up_url: w.topUpUrl }, replayed: r.replayed });
      }),
  );

  server.registerTool(
    "update_reminder",
    {
      title: "Pause or resume a reminder",
      description: "Pause (releases reserved credits, keeps the reminder) or resume (re-reserves) an existing reminder. To change dates, label or times, use prepare_reminder with reminder_id followed by confirm_reminder.",
      inputSchema: {
        reminder_id: z.string().uuid(),
        action: z.enum(["pause", "resume"]),
        idempotency_key: z.string().min(1).max(64),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      run("update_reminder", extra, async (p) => {
        const r = await setReminderStatus(p, args.reminder_id, args.action, { idempotencyKey: args.idempotency_key });
        return ok(`Reminder ${args.action === "pause" ? "paused" : "resumed"}: "${r.reminder?.label}".`, { reminder: r.reminder ? reminderOut(r.reminder) : null, cancelled_jobs: r.cancelled, resumed_jobs: r.resumed, replayed: r.replayed });
      }),
  );

  server.registerTool(
    "cancel_reminder",
    {
      title: "Cancel a reminder",
      description: "Cancels all unsent SMS for a reminder and releases their reserved credits. Already-sent SMS stay in history and are not refunded. Requires confirm=true after the user agrees.",
      inputSchema: {
        reminder_id: z.string().uuid(),
        confirm: z.boolean().describe("Must be true; ask the user first."),
        idempotency_key: z.string().min(1).max(64),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      run("cancel_reminder", extra, async (p) => {
        if (!args.confirm) return fail("confirmation_required", "Ask the user to confirm cancellation, then call again with confirm=true.");
        const r = await setReminderStatus(p, args.reminder_id, "cancel", { idempotencyKey: args.idempotency_key });
        const released = r.reminder?.jobs.filter((j) => j.status === "cancelled").reduce((s, j) => s + j.estimatedCredits, 0) ?? 0;
        return ok(`Cancelled ${r.cancelled} unsent SMS for "${r.reminder?.label}".`, { reminder_id: args.reminder_id, cancelled_jobs: r.cancelled, released_credits: r.replayed ? 0 : released, sent_history_kept: true, replayed: r.replayed });
      }),
  );

  return server;
}

function reminderOut(r: import("../core/dto").ReminderDTO) {
  return {
    id: r.id,
    label: r.label,
    category: r.category,
    status: r.status,
    cycle_no: r.cycleNo,
    expiry_at_utc: r.expiry.utc,
    expiry_local: `${r.expiry.local} NPT`,
    expiry_ad: r.expiry.ad,
    expiry_bs: r.expiry.bs?.date ?? null,
    expiry_bs_display: r.expiry.bs?.display ?? null,
    jobs: r.jobs.map((j) => ({ id: j.id, offset_minutes: j.offsetMinutes, due_local: `${j.due.local} NPT`, due_at_utc: j.due.utc, status: j.status, estimated_credits: j.estimatedCredits })),
  };
}

export const TOOL_NAMES = ["get_account", "get_credit_balance", "list_reminders", "prepare_reminder", "confirm_reminder", "update_reminder", "cancel_reminder"] as const;
