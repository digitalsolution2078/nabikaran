import { env } from "../env";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getDb } from "../db";
import { audit } from "../core/audit";
import { HttpError, RateLimitError, ScopeError } from "../core/errors";
import { principalSubject, requireScope, type Principal } from "../core/principal";
import { listGroups } from "../services/groups";
import { checkRateLimit, countEvent } from "../core/rate-limit";
import { getAccount } from "../core/account";
import { getWalletSummary } from "../core/wallet";
import { listReminders, setReminderStatus, CATEGORIES, SUB_CURRENCIES, listRenewalHistory, markRenewed } from "../core/reminders";
import { getPlanState, isPro, startTrial } from "../services/plans";
import { listSubscriptions } from "../services/subscriptions";
import { getInsights } from "../services/insights";
import { prepareReminderAction, confirmPreparedAction } from "../core/prepared-actions";
import { recordUsage } from "../services/limits";
import { MAX_OFFSET_MINUTES } from "../scheduler";

/**
 * MCP tool surface (docs/MCP_ARCHITECTURE.md §6). Phase 2: read tools.
 *
 * Identity comes ONLY from `extra.authInfo.extra.principal`, which the HTTP
 * handler sets after validating the bearer token. No tool accepts a user id.
 * Scope checks live in core; this layer adds per-token rate limits, audit and
 * error mapping.
 */
export const MCP_SERVER_INFO = { name: "nabikaran", version: "0.3.0" } as const;
export const TOOL_RATE_LIMIT = { bucket: "mcp:call", limit: 60, windowSeconds: 60 } as const;
export const PREPARE_RATE_LIMIT = { bucket: "mcp:prepare", limit: 20, windowSeconds: 600 } as const;
/** @deprecated record limits now come from Admin → Settings (services/limits.ts). */
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
      const more = e.code === "insufficient_credits" ? { ...e.detail, top_up_url: `${env.appUrl}/wallet` } : e.code === "pro_required" ? { ...e.detail, upgrade_url: `${env.appUrl}/pricing` } : e.detail;
      return fail(e.code ?? "error", e.message, more);
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
      "Birthdays and anniversaries of friends or family: use category birthday/anniversary with repeat_yearly=true; the SMS still goes to the user, never to the friend.",
      "Dates: Nepal time (Asia/Kathmandu). Both Gregorian (AD) and Bikram Sambat (BS) are returned; always show the user both when they matter.",
      "Nabikaran Pro (get_pro_status) adds a subscription manager: add a subscription with prepare_reminder (subscription fields, repeat_months), then list_subscriptions, get_spending_insights, mark_subscription_renewed and list_renewal_history.",
      "Pro tools answer pro_required with an upgrade_url for Basic accounts. Buying Pro, top-ups and gift cards happen only on the website. Never claim Nabikaran cancels a subscription: the user cancels with the provider; Nabikaran reminds them before the deadline.",
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
        const lines = reminders.map((r) => `• ${r.label} (${r.category})${r.repeatYearly ? " [every year]" : ""} on ${r.expiry.local} NPT${r.expiry.bs ? ` / BS ${r.expiry.bs.display}` : ""} — ${r.status}, ${r.jobs.length} reminder(s)`);
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
            repeat_yearly: r.repeatYearly,
            group_id: r.groupId,
            jobs: r.jobs.map((j) => ({ id: j.id, offset_minutes: j.offsetMinutes, due_local: `${j.due.local} NPT`, due_at_utc: j.due.utc, status: j.status, estimated_credits: j.estimatedCredits })),
          })),
          next_cursor: nextCursor,
        });
      }),
  );

  server.registerTool(
    "list_groups",
    {
      title: "List reminder groups",
      description: "The user's reminder groups (e.g. \"Friends' birthdays\") with their type and how many active reminders each has. Use a group_id with prepare_reminder to file a new reminder in a group.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) =>
      run("list_groups", extra, async (p) => {
        requireScope(p, "reminders:read");
        const groups = await listGroups(p.userId);
        return ok(groups.length ? groups.map((g) => `• ${g.name} (${g.kind}) — ${g.active} active`).join("\n") : "No groups yet. The user can create groups on the website (Reminders → Manage groups).", {
          groups: groups.map((g) => ({ id: g.id, name: g.name, kind: g.kind, active_reminders: g.active, total_reminders: g.total })),
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
        channels: z.array(z.enum(["sms", "whatsapp", "push"])).min(1).max(3).optional().describe("Delivery channels; default SMS. \"push\" = free app notification to the user's phones with notifications on (no credits). WhatsApp works only if the user enabled it on the website (assistants cannot give WhatsApp consent). Messages always go to the account holder's own verified number."),
        repeat_yearly: z.boolean().optional().describe("Repeat every year on the same day. Use for birthdays and anniversaries (category birthday / anniversary, label = the person's name in English letters). A past date such as a birth date moves to the next occurrence. The reminder still goes only to the account holder, never to the person whose birthday it is. Birthday/anniversary/event reminders are SMS only."),
        group_id: z.string().uuid().nullable().optional().describe("Optional group from list_groups, e.g. the user's 'Friends' birthdays' group."),
        repeat_months: z.number().int().min(1).max(11).nullable().optional().describe("Repeat every N months: 1 monthly, 3 quarterly, 6 half-yearly. For yearly use repeat_yearly=true. Every plan."),
        subscription: z.object({
          amount: z.number().min(0).max(100_000_000).nullable().default(null).describe("What one renewal costs, as the user stated it. Never estimate."),
          currency: z.enum(SUB_CURRENCIES).default("NPR"),
          payment_method: z.string().max(40).nullable().default(null).describe("e.g. 'eSewa', 'Khalti', 'Visa ending 1234'. Never ask for full card numbers."),
          auto_renew: z.boolean().nullable().default(null),
          is_trial: z.boolean().default(false).describe("The date is when a free trial turns into a paid subscription."),
          cancel_notice_days: z.number().int().min(0).max(90).nullable().default(null).describe("The provider needs cancelling this many days before renewal: adds a 'last day to cancel' reminder."),
        }).nullable().optional().describe("PRO ONLY. Makes this a tracked subscription (category subscription or free_trial). Basic accounts get pro_required with an upgrade_url."),
        use_credits: z.boolean().optional().describe("Pro: set true only after the user agreed to use wallet credits when confirm_reminder returned credits_permission_required."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      run("prepare_reminder", extra, async (p) => {
        const db = getDb();
        await checkRateLimit(db, `user:${p.userId}`, PREPARE_RATE_LIMIT);
        if (!args.reminder_id) {
          const u = await recordUsage(p.userId, db);
          if (u.used >= u.limit) return fail("limit_reached", `This account has ${u.used} of ${u.limit} records${u.pro ? "" : ` (Nabikaran Pro keeps up to ${u.proLimit})`}. Delete old ones to add more.`);
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

  // ---------------------------------------------------------------------------
  // Nabikaran Pro: plan status and the subscription manager.
  // ---------------------------------------------------------------------------
  const proOnly = async (p: Principal) => {
    if (!(await isPro(p.userId))) throw new HttpError(403, "This is a Nabikaran Pro feature. The user can start a free trial or upgrade on the website.", "pro_required");
  };
  const money = (cur: string | null, n: number | null) => (n === null ? "—" : `${cur ?? "NPR"} ${Math.round(n * 100) / 100}`);

  server.registerTool(
    "get_pro_status",
    {
      title: "Get Pro plan status",
      description: "Whether the account is on Basic or Nabikaran Pro (trial / paid / given), when Pro ends, included messages left (SMS / WhatsApp / email), the current offer (price, trial) and links. Buying or renewing Pro happens on the website only.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) =>
      run("get_pro_status", extra, async (p) => {
        requireScope(p, "account:read");
        const s = await getPlanState(p.userId);
        const base = env.appUrl.replace(/\/$/, "");
        const left = s.allowances.map((a) => `${a.channel} ${a.left}/${a.granted}`).join(", ");
        const summary = s.tier === "pro"
          ? `Nabikaran Pro (${s.kind}) until ${s.endsAt?.slice(0, 10)} — ${s.daysLeft} day(s) left.${left ? ` Included messages left: ${left}.` : " A free trial has no included messages."}${s.queuedUntil ? ` Another year is already bought, until ${s.queuedUntil.slice(0, 10)}.` : ""}`
          : `Basic plan.${s.offer.enabled ? ` Pro costs NPR ${s.offer.price_npr} for ${s.offer.duration_days} days${s.offer.trial_enabled && !s.trialUsed ? `; a ${s.offer.trial_days}-day free trial is available (start_pro_trial)` : ""}.` : " Pro is not on sale right now."}`;
        return ok(summary, {
          tier: s.tier, kind: s.kind, starts_at: s.startsAt, ends_at: s.endsAt, days_left: s.daysLeft, renewed_until: s.queuedUntil,
          included_messages: s.allowances.map((a) => ({ channel: a.channel, included: a.granted, used: a.used, held: a.reserved, left: a.left })),
          monthly_credits: s.monthlyCredits,
          this_month_credits: s.monthGrant ? { credits: s.monthGrant.credits, unused_expire_at: s.monthGrant.expiresAt } : null,
          offer: s.offer.enabled ? { price_npr: s.offer.price_npr, duration_days: s.offer.duration_days, included: { sms: s.offer.allowance_sms, whatsapp: s.offer.allowance_whatsapp, email: s.offer.allowance_email }, monthly_credits: s.offer.monthly_credits, trial_days: s.offer.trial_enabled ? s.offer.trial_days : 0 } : null,
          trial_available: s.offer.enabled && s.offer.trial_enabled && !s.trialUsed && s.tier === "basic",
          pricing_url: `${base}/pricing`, manage_url: `${base}/pro`,
          note: "Purchases are made on the website with wallet credits and are final (no refunds). Nothing renews automatically.",
        });
      }),
  );

  server.registerTool(
    "start_pro_trial",
    {
      title: "Start the free Pro trial",
      description: "Starts the one-time free Nabikaran Pro trial (all Pro features, no included messages, no payment, nothing renews). Ask the user first and pass confirm=true only after they agree.",
      inputSchema: { confirm: z.boolean().describe("Must be true; ask the user first.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) =>
      run("start_pro_trial", extra, async (p) => {
        requireScope(p, "reminders:write");
        if (!args.confirm) return fail("confirmation_required", "Ask the user whether to start the free trial, then call again with confirm=true.");
        const s = await startTrial(p.userId);
        return ok(`Free Pro trial started; it ends on ${s.endsAt?.slice(0, 10)}. It has all Pro features but no included messages; messages use wallet credits as usual.`, { tier: s.tier, kind: s.kind, ends_at: s.endsAt, days_left: s.daysLeft });
      }),
  );

  server.registerTool(
    "list_subscriptions",
    {
      title: "List subscriptions (Pro)",
      description: "PRO. The user's tracked subscriptions (Netflix, internet, insurance, domains…): amount, cycle, next charge date, payment method, auto-renew, free trials and cancel notice, plus monthly / yearly totals per currency from the amounts the user entered.",
      inputSchema: { include_cancelled: z.boolean().default(false) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      run("list_subscriptions", extra, async (p) => {
        requireScope(p, "reminders:read");
        await proOnly(p);
        const v = await listSubscriptions(p.userId);
        const items = v.items.filter((i) => args.include_cancelled || i.status === "active" || i.status === "paused");
        const cycle = (m: number | null) => (m === null ? "one-time" : m === 1 ? "monthly" : m === 12 ? "yearly" : `every ${m} months`);
        const lines = items.map((i) => `• ${i.label}: ${money(i.currency, i.amount)} ${cycle(i.cycleMonths)}, next ${i.nextAt.slice(0, 10)}${i.isTrial ? " (free trial ends)" : ""}${i.paymentMethod ? ` via ${i.paymentMethod}` : ""}${i.status !== "active" ? ` [${i.status}]` : ""}`);
        const totals = v.totals.map((t) => `${money(t.currency, t.monthly)}/month (${money(t.currency, t.yearly)}/year)`).join("; ");
        return ok(items.length ? `${lines.join("\n")}${totals ? `\nTotal: ${totals}` : ""}` : "No subscriptions yet. Add one with prepare_reminder (category subscription, subscription fields, repeat_months).", {
          subscriptions: items.map((i) => ({
            id: i.id, label: i.label, status: i.status, next_date: i.nextAt, amount: i.amount, currency: i.currency, cycle_months: i.cycleMonths,
            payment_method: i.paymentMethod, auto_renew: i.autoRenew, is_trial: i.isTrial, cancel_notice_days: i.cancelNoticeDays, channels: i.channels,
          })),
          totals: v.totals,
          note: "Totals come only from amounts the user entered; Nabikaran does not read bank statements or cancel subscriptions.",
        });
      }),
  );

  server.registerTool(
    "get_spending_insights",
    {
      title: "Spending insights (Pro)",
      description: "PRO. Monthly and yearly subscription cost per currency, cost by payment method, charges due in the next 30 days, total due in 90 days, free trials ending, last days to cancel, and what was renewed in the last 12 months. Figures come only from what the user entered.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) =>
      run("get_spending_insights", extra, async (p) => {
        requireScope(p, "reminders:read");
        await proOnly(p);
        const i = await getInsights(p.userId);
        const parts = [
          i.totals.length ? `Subscriptions cost ${i.totals.map((t) => `${money(t.currency, t.monthly)}/month`).join(", ")}.` : "No amounts entered yet.",
          i.upcoming90Total.length ? `Due in the next 90 days: ${i.upcoming90Total.map((t) => money(t.currency, t.amount)).join(", ")}.` : "",
          i.trialsEnding.length ? `Free trials ending in 30 days: ${i.trialsEnding.map((t) => `${t.label} (${t.dueAt.slice(0, 10)})`).join(", ")}.` : "",
          i.cancelAlerts.length ? `Last days to cancel: ${i.cancelAlerts.map((t) => `${t.label} (${t.dueAt.slice(0, 10)})`).join(", ")}.` : "",
        ].filter(Boolean);
        return ok(parts.join(" "), {
          totals: i.totals, by_payment_method: i.byMethod, due_next_90_days: i.upcoming90Total, subscription_count: i.subscriptionCount,
          upcoming_30_days: i.upcoming30.map((s) => ({ id: s.id, label: s.label, date: s.nextAt, amount: s.amount, currency: s.currency })),
          trials_ending: i.trialsEnding, cancel_deadlines: i.cancelAlerts, deadlines_30_days: i.deadlines30, renewed_last_12_months: i.spentLast12,
          note: "Only amounts the user entered. Not financial advice; no savings are guaranteed.",
        });
      }),
  );

  server.registerTool(
    "list_renewal_history",
    {
      title: "Renewal history (Pro)",
      description: "PRO. What the user renewed and paid, newest first (from 'mark as renewed' and automatic roll-overs). Optional reminder_id to see one item's history.",
      inputSchema: { reminder_id: z.string().uuid().optional(), limit: z.number().int().min(1).max(100).default(30) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      run("list_renewal_history", extra, async (p) => {
        requireScope(p, "reminders:read");
        await proOnly(p);
        const rows = (await listRenewalHistory(p.userId)).filter((h) => !args.reminder_id || h.renewalId === args.reminder_id).slice(0, args.limit);
        return ok(rows.length ? rows.map((h) => `• ${h.renewedOn} ${h.label}${h.amount !== null ? ` — ${money(h.currency, h.amount)}` : ""}${h.nextDue ? `, next ${h.nextDue.slice(0, 10)}` : ""}`).join("\n") : "No renewals recorded yet.", {
          history: rows.map((h) => ({ id: h.id, reminder_id: h.renewalId, label: h.label, category: h.category, renewed_on: h.renewedOn, amount: h.amount, currency: h.currency, previous_due: h.previousDue, next_due: h.nextDue, source: h.source, note: h.note })),
        });
      }),
  );

  server.registerTool(
    "mark_subscription_renewed",
    {
      title: "Mark as renewed (Pro)",
      description: "PRO. Records that the user renewed / paid a reminder or subscription (date, amount) in their renewal history. Repeating items move to their next date on their own; a one-time item needs next_expiry_date (same calendar as the reminder). Ask the user first and pass confirm=true.",
      inputSchema: {
        reminder_id: z.string().uuid(),
        renewed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Gregorian date the user renewed / paid (YYYY-MM-DD)."),
        amount: z.number().min(0).max(100_000_000).nullable().default(null).describe("What the user paid, if they said."),
        currency: z.enum(SUB_CURRENCIES).default("NPR"),
        note: z.string().max(200).nullable().default(null),
        next_expiry_date: z.string().max(12).nullable().default(null).describe("One-time reminders only: the new expiry date (YYYY-MM-DD) in the reminder's calendar."),
        use_credits: z.boolean().optional().describe("Set true only after the user agreed, when a previous call returned credits_permission_required."),
        confirm: z.boolean().describe("Must be true; ask the user first."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) =>
      run("mark_subscription_renewed", extra, async (p) => {
        if (!args.confirm) return fail("confirmation_required", "Show the user what will be recorded, then call again with confirm=true.");
        await proOnly(p);
        const r = await markRenewed(p, args.reminder_id, { renewedOn: args.renewed_on, amount: args.amount, currency: args.currency, note: args.note, nextExpiryDate: args.next_expiry_date, useCredits: args.use_credits });
        return ok(`Recorded: "${r.reminder.label}" renewed on ${args.renewed_on}${args.amount !== null ? ` for ${money(args.currency, args.amount)}` : ""}. Next date ${r.reminder.expiry.ad}.`, {
          reminder: reminderOut(r.reminder),
          history: r.history.slice(0, 5).map((h) => ({ renewed_on: h.renewedOn, amount: h.amount, currency: h.currency, next_due: h.nextDue })),
        });
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
    repeat_yearly: r.repeatYearly,
    group_id: r.groupId,
    jobs: r.jobs.map((j) => ({ id: j.id, offset_minutes: j.offsetMinutes, due_local: `${j.due.local} NPT`, due_at_utc: j.due.utc, status: j.status, estimated_credits: j.estimatedCredits })),
  };
}

export const TOOL_NAMES = [
  "get_account", "get_credit_balance", "list_reminders", "list_groups", "prepare_reminder", "confirm_reminder", "update_reminder", "cancel_reminder",
  "get_pro_status", "start_pro_trial", "list_subscriptions", "get_spending_insights", "list_renewal_history", "mark_subscription_renewed",
] as const;
