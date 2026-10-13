import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTestDb, createUser, fund, inDays, wallet } from "./helpers/db";
import type { Db } from "@/lib/db";
import { env } from "@/lib/env";
import { handleMcpRequest } from "@/lib/mcp/handler";
import { registerClient } from "@/lib/oauth/clients";
import { validateAuthorizeRequest, issueAuthorizationCode } from "@/lib/oauth/codes";
import { exchangeToken } from "@/lib/oauth/tokens";
import { makePkcePair } from "@/lib/oauth/pkce";
import { setSetting } from "@/lib/services/settings";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let clientId: string;
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const localFetch: typeof fetch = async (input, init) => handleMcpRequest(new Request(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, init));

async function tokenFor(userId: string, scope?: string) {
  const pkce = makePkcePair();
  const v = await validateAuthorizeRequest({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope: scope ?? null, code_challenge: pkce.challenge, code_challenge_method: "S256", resource: env.mcpResource }, db);
  const code = await issueAuthorizationCode(v, userId, db);
  return (await exchangeToken({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: pkce.verifier }, db)).access_token;
}
async function connect(userId: string, scope?: string) {
  const client = new Client({ name: "t", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(env.mcpResource), { fetch: localFetch, requestInit: { headers: { authorization: `Bearer ${await tokenFor(userId, scope)}` } } }));
  return client;
}
type R = { isError?: boolean; structuredContent?: Record<string, unknown> & { error?: string }; content: Array<{ type: string; text?: string }> };
const call = (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args }) as Promise<R>;
let seq = 0;
const key = () => `k-${Date.now()}-${++seq}`;
const prep = (over: Record<string, unknown> = {}) => ({ category: "bluebook", label: "Ba 2 Pa 1234", expiry: { calendar: "AD", date: inDays(40), source: "user_typed" }, offsets_minutes: [7 * 1440, 1440], ...over });

const PRO = { enabled: true, price_npr: 1000, duration_days: 365, trial_enabled: true, trial_days: 7, allowance_sms: 100, allowance_whatsapp: 100, allowance_email: 400, monthly_credits: 0 };
const subPrep = (over: Record<string, unknown> = {}) => ({
  category: "subscription", label: "Netflix", expiry: { calendar: "AD", date: inDays(20), source: "user_typed" }, offsets_minutes: [3 * 1440],
  repeat_months: 1, subscription: { amount: 1499, currency: "NPR", payment_method: "Visa 1234", auto_renew: true, cancel_notice_days: null }, ...over,
});

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const { client } = await registerClient({ client_name: "ChatGPT", redirect_uris: [REDIRECT] }, {}, db);
  clientId = client.id;
  const admin = await createUser(db, "+9779841000890", "admin");
  await setSetting({ id: admin }, "pro", PRO, db);
});
afterAll(() => close());

describe("MCP: Pro plan and subscription manager", () => {
  it("Basic: status shows the offer; Pro tools answer pro_required with an upgrade link", async () => {
    const u = await createUser(db, "+9779841000891");
    const c = await connect(u);
    const st = await call(c, "get_pro_status");
    expect(st.structuredContent).toMatchObject({ tier: "basic", trial_available: true });
    expect(String(st.structuredContent!.pricing_url)).toMatch(/\/pricing$/);
    for (const tool of ["list_subscriptions", "get_spending_insights", "list_renewal_history"]) {
      const r = await call(c, tool);
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({ error: "pro_required" });
      expect(String(r.structuredContent!.upgrade_url)).toMatch(/\/pricing$/);
    }
    const p = await call(c, "prepare_reminder", subPrep());
    expect(p.structuredContent).toMatchObject({ error: "pro_required" });
    // A plain monthly reminder is fine on Basic.
    await fund(db, u, 50);
    const m = await call(c, "prepare_reminder", subPrep({ subscription: undefined, category: "other", label: "Rent" }));
    expect(m.isError).toBeFalsy();
    await c.close();
  });

  it("starts the trial only after confirmation, once", async () => {
    const u = await createUser(db, "+9779841000892");
    const c = await connect(u);
    expect((await call(c, "start_pro_trial", { confirm: false })).structuredContent).toMatchObject({ error: "confirmation_required" });
    const r = await call(c, "start_pro_trial", { confirm: true });
    expect(r.structuredContent).toMatchObject({ tier: "pro", kind: "trial" });
    expect((await call(c, "start_pro_trial", { confirm: true })).isError).toBe(true);
    expect((await call(c, "get_pro_status")).structuredContent).toMatchObject({ tier: "pro", kind: "trial", trial_available: false });
    await c.close();
  });

  it("Pro: add a subscription, list it with totals, insights, mark renewed, history", async () => {
    const u = await createUser(db, "+9779841000893");
    await fund(db, u, 100);
    const c = await connect(u);
    await call(c, "start_pro_trial", { confirm: true });
    const p = await call(c, "prepare_reminder", subPrep({ subscription: { amount: 1499, currency: "NPR", payment_method: "Visa 1234", auto_renew: true, cancel_notice_days: 2 } }));
    expect(p.isError).toBeFalsy();
    expect(String(p.structuredContent!.confirmation_prompt)).toContain("Repeats every month");
    expect(String(p.structuredContent!.confirmation_prompt)).toContain("NPR 1499 via Visa 1234");
    const conf = await call(c, "confirm_reminder", { prepared_id: p.structuredContent!.prepared_id, expected_expiry_ad: p.structuredContent!.expected_expiry_ad, idempotency_key: key() });
    expect(conf.isError).toBeFalsy();
    const id = (conf.structuredContent!.reminder as { id: string }).id;

    const subs = await call(c, "list_subscriptions");
    const list = subs.structuredContent!.subscriptions as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, label: "Netflix", amount: 1499, cycle_months: 1, payment_method: "Visa 1234", cancel_notice_days: 2 });
    expect(subs.structuredContent!.totals).toEqual([{ currency: "NPR", monthly: 1499, yearly: 17988 }]);

    const ins = await call(c, "get_spending_insights");
    expect(ins.isError).toBeFalsy();
    expect((ins.structuredContent!.cancel_deadlines as unknown[]).length).toBe(1);
    expect(ins.structuredContent!.subscription_count).toBe(1);

    expect((await call(c, "mark_subscription_renewed", { reminder_id: id, renewed_on: inDays(0), amount: 1499, confirm: false })).structuredContent).toMatchObject({ error: "confirmation_required" });
    const mr = await call(c, "mark_subscription_renewed", { reminder_id: id, renewed_on: inDays(0), amount: 1499, confirm: true });
    expect(mr.isError).toBeFalsy();
    const h = await call(c, "list_renewal_history", { reminder_id: id });
    expect((h.structuredContent!.history as Array<Record<string, unknown>>)[0]).toMatchObject({ reminder_id: id, amount: 1499, currency: "NPR" });
    await c.close();
  });

  it("Pro tools need the right scopes", async () => {
    const u = await createUser(db, "+9779841000894");
    const c = await connect(u, "account:read");
    expect((await call(c, "get_pro_status")).isError).toBeFalsy();
    expect((await call(c, "list_subscriptions")).structuredContent).toMatchObject({ error: "insufficient_scope" });
    expect((await call(c, "start_pro_trial", { confirm: true })).structuredContent).toMatchObject({ error: "insufficient_scope" });
    await c.close();
  });
});
