import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getDb } from "../db";
import { audit } from "../core/audit";
import { HttpError, RateLimitError, ScopeError } from "../core/errors";
import { principalSubject, type Principal } from "../core/principal";
import { checkRateLimit } from "../core/rate-limit";
import { getAccount } from "../core/account";
import { getWalletSummary } from "../core/wallet";
import { listReminders, CATEGORIES } from "../core/reminders";

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
    return result;
  } catch (e) {
    if (e instanceof RateLimitError) return fail("rate_limited", `Too many requests. Retry after ${e.retryAfterSeconds}s.`, { retry_after_seconds: e.retryAfterSeconds });
    if (e instanceof ScopeError) {
      await audit(db, p, `mcp.${tool}`, null, { ok: false, error: "insufficient_scope", scope: e.scope });
      return fail("insufficient_scope", `This connection was not granted the "${e.scope}" permission. Reconnect Nabikaran and allow it.`, { required_scope: e.scope });
    }
    if (e instanceof HttpError) {
      await audit(db, p, `mcp.${tool}`, null, { ok: false, error: e.code ?? e.status });
      return fail(e.code ?? "error", e.message);
    }
    console.error(`[mcp] ${tool} failed`, e);
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

  return server;
}

export const TOOL_NAMES = ["get_account", "get_credit_balance", "list_reminders"] as const;
