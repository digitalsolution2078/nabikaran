import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTestDb, createUser, fund, inDays, principalFor } from "./helpers/db";
import type { Db } from "@/lib/db";
import { env } from "@/lib/env";
import { handleMcpRequest } from "@/lib/mcp/handler";
import { TOOL_NAMES, TOOL_RATE_LIMIT } from "@/lib/mcp/server";
import { registerClient } from "@/lib/oauth/clients";
import { validateAuthorizeRequest, issueAuthorizationCode } from "@/lib/oauth/codes";
import { exchangeToken, revokeAllForUserClient } from "@/lib/oauth/tokens";
import { makePkcePair } from "@/lib/oauth/pkce";
import { createReminder } from "@/lib/core/reminders";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let alice: string;
let bob: string;
let clientId: string;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

/** Route the SDK client's fetch straight into the handler (no network). */
const localFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  return handleMcpRequest(new Request(url, init));
};

async function tokenFor(userId: string, scope?: string): Promise<string> {
  const pkce = makePkcePair();
  const v = await validateAuthorizeRequest({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope: scope ?? null, code_challenge: pkce.challenge, code_challenge_method: "S256", resource: env.mcpResource }, db);
  const code = await issueAuthorizationCode(v, userId, db);
  return (await exchangeToken({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: pkce.verifier }, db)).access_token;
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(env.mcpResource), { fetch: localFetch, requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ type: string; text?: string }> };
const call = (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args }) as Promise<ToolResult>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  alice = await createUser(db, "+9779841000701");
  bob = await createUser(db, "+9779841000702");
  await fund(db, alice, 120);
  const { client } = await registerClient({ client_name: "Claude", redirect_uris: [REDIRECT] }, {}, db);
  clientId = client.id;
  await createReminder(principalFor(alice), { category: "bluebook", label: "Ba 2 Pa 1234", calendar: "BS", expiryDate: "2084-02-10", localTime: "09:00", notes: null, familyMemberLabel: null, offsets: [7 * 1440, 0] }, {}, db);
  await createReminder(principalFor(alice), { category: "passport", label: "Passport", calendar: "AD", expiryDate: inDays(400), localTime: "09:00", notes: null, familyMemberLabel: null, offsets: [30 * 1440] }, {}, db);
});
afterAll(() => close());

describe("MCP authentication", () => {
  it("401 + WWW-Authenticate pointing at protected-resource metadata when no/invalid token", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } });
    const res = await handleMcpRequest(new Request(env.mcpResource, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer resource_metadata="/);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const bad = await handleMcpRequest(new Request(env.mcpResource, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer nope" }, body }));
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
  });

  it("OPTIONS preflight succeeds without auth; oversized bodies are rejected", async () => {
    expect((await handleMcpRequest(new Request(env.mcpResource, { method: "OPTIONS" }))).status).toBe(204);
    const big = await handleMcpRequest(new Request(env.mcpResource, { method: "POST", headers: { "content-length": String(10 * 1024 * 1024) }, body: "{}" }));
    expect(big.status).toBe(413);
  });

  it("a revoked token stops working immediately", async () => {
    const token = await tokenFor(bob);
    const c = await connect(token);
    expect((await call(c, "get_account")).isError).toBeFalsy();
    await revokeAllForUserClient(bob, clientId, "user_disconnected", db);
    await expect(call(c, "get_account")).rejects.toThrow(/401|Unauthorized|invalid_token|Error POSTing/);
    await c.close();
  });
});

describe("MCP tools", () => {
  it("lists exactly the Phase 2 read tools with read-only annotations", async () => {
    const c = await connect(await tokenFor(alice));
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    await c.close();
  });

  it("get_account and get_credit_balance resolve the user from the token only", async () => {
    const c = await connect(await tokenFor(alice));
    const acct = await call(c, "get_account");
    expect(acct.structuredContent).toMatchObject({ phone_masked: "+9779841****01", phone_verified: true, timezone: "Asia/Kathmandu" });
    const bal = await call(c, "get_credit_balance");
    expect(bal.structuredContent).toMatchObject({ available_credits: expect.any(Number), reserved_credits: expect.any(Number), credits_per_sms_segment: 3 });
    expect(String(bal.structuredContent!.top_up_url)).toMatch(/\/wallet$/);
    expect((bal.structuredContent!.available_credits as number) + (bal.structuredContent!.reserved_credits as number)).toBe(120);
    await c.close();
  });

  it("list_reminders returns AD + BS dates and per-SMS status; filters and paginates", async () => {
    const c = await connect(await tokenFor(alice));
    const all = await call(c, "list_reminders", { status: "all" });
    const rs = all.structuredContent!.reminders as Array<Record<string, unknown>>;
    expect(rs).toHaveLength(2);
    const bluebook = rs.find((r) => r.label === "Ba 2 Pa 1234")!;
    expect(bluebook.expiry_bs).toBe("2084-02-10");
    expect(String(bluebook.expiry_local)).toMatch(/NPT$/);
    expect((bluebook.jobs as unknown[]).length).toBe(2);
    const page1 = await call(c, "list_reminders", { status: "all", limit: 1 });
    expect((page1.structuredContent!.reminders as unknown[]).length).toBe(1);
    expect(page1.structuredContent!.next_cursor).toBeTruthy();
    const page2 = await call(c, "list_reminders", { status: "all", limit: 1, cursor: page1.structuredContent!.next_cursor });
    expect((page2.structuredContent!.reminders as Array<{ id: string }>)[0].id).not.toBe((page1.structuredContent!.reminders as Array<{ id: string }>)[0].id);
    expect((await call(c, "list_reminders", { category: "passport" })).structuredContent!.reminders).toHaveLength(1);
    await c.close();
  });

  it("user isolation: Bob's token never sees Alice's reminders or balance", async () => {
    const c = await connect(await tokenFor(bob));
    expect((await call(c, "list_reminders", { status: "all" })).structuredContent!.reminders).toEqual([]);
    expect((await call(c, "get_credit_balance")).structuredContent).toMatchObject({ available_credits: 0 });
    await c.close();
  });

  it("missing scope yields a tool error naming the scope, not data", async () => {
    const c = await connect(await tokenFor(alice, "account:read"));
    const r = await call(c, "get_credit_balance");
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ error: "insufficient_scope", required_scope: "wallet:read" });
    expect((await call(c, "get_account")).isError).toBeFalsy();
    await c.close();
  });

  it("per-token rate limit and audit trail", async () => {
    const token = await tokenFor(alice);
    const c = await connect(token);
    let limited: ToolResult | null = null;
    for (let i = 0; i < TOOL_RATE_LIMIT.limit + 1; i++) {
      const r = await call(c, "get_account");
      if (r.isError) { limited = r; break; }
    }
    expect(limited?.structuredContent).toMatchObject({ error: "rate_limited" });
    const { rows } = await db.query<{ n: string; via: string; client: string }>(
      "select count(*)::text as n, min(actor_via) as via, min(actor_client_id) as client from audit_events where action = 'mcp.get_account' and actor_user_id = $1",
      [alice],
    );
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(TOOL_RATE_LIMIT.limit);
    expect(rows[0]).toMatchObject({ via: "mcp", client: clientId });
    await c.close();
  });
});
