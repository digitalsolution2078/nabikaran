import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund } from "./helpers/db";
import type { Db } from "@/lib/db";
import { env } from "@/lib/env";
import { registerClient } from "@/lib/oauth/clients";
import { validateAuthorizeRequest, issueAuthorizationCode } from "@/lib/oauth/codes";
import { exchangeToken, verifyAccessToken, setClientDisabled, listClientsForAdmin, revokeAllForUserClient, invalidateTokenCache, tokenCacheSize } from "@/lib/oauth/tokens";
import { makePkcePair } from "@/lib/oauth/pkce";
import { countEvent, sumEvents, pruneRateLimitWindows } from "@/lib/core/rate-limit";
import { getMetrics } from "@/lib/services/admin";
import { handleMcpRequest } from "@/lib/mcp/handler";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let userId: string;
let admin: string;
let clientId: string;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

async function token(uid = userId, cid = clientId) {
  const pkce = makePkcePair();
  const v = await validateAuthorizeRequest({ response_type: "code", client_id: cid, redirect_uri: REDIRECT, code_challenge: pkce.challenge, code_challenge_method: "S256", resource: env.mcpResource }, db);
  const code = await issueAuthorizationCode(v, uid, db);
  return (await exchangeToken({ grant_type: "authorization_code", client_id: cid, code, code_verifier: pkce.verifier }, db)).access_token;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  userId = await createUser(db, "+9779841000901");
  admin = await createUser(db, "+9779841000902", "admin");
  await fund(db, userId, 10);
  const { client } = await registerClient({ client_name: "Claude", redirect_uris: [REDIRECT] }, {}, db);
  clientId = client.id;
});
afterAll(() => close());

describe("admin kill-switch", () => {
  it("disabling a client makes every token fail at once; enabling restores them", async () => {
    const t = await token();
    expect((await verifyAccessToken(t, db)).ok).toBe(true);
    expect(await setClientDisabled(admin, clientId, true, db)).toBe(true);
    expect(await verifyAccessToken(t, db)).toEqual({ ok: false, reason: "revoked" });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const res = await handleMcpRequest(new Request(env.mcpResource, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${t}` }, body }));
    expect(res.status).toBe(401);
    // a disabled client cannot start a new authorization either
    await expect(validateAuthorizeRequest({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: makePkcePair().challenge, code_challenge_method: "S256" }, db)).rejects.toMatchObject({ error: "invalid_client" });
    await setClientDisabled(admin, clientId, false, db);
    expect((await verifyAccessToken(t, db)).ok).toBe(true);
    const list = await listClientsForAdmin(db);
    const row = list.find((c) => c.id === clientId)!;
    expect(row).toMatchObject({ name: "Claude", disabledAt: null });
    expect(row.activeUsers).toBeGreaterThanOrEqual(1);
    expect(await setClientDisabled(admin, "nb_missing", true, db)).toBe(false);
    const { rows } = await db.query("select 1 from audit_events where action in ('oauth.client_disabled','oauth.client_enabled') and actor_user_id = $1", [admin]);
    expect(rows.length).toBe(2);
  });
});

describe("token cache", () => {
  it("is off under test (TOKEN_CACHE_SECONDS=0) and revocations clear it regardless", async () => {
    const t = await token();
    await verifyAccessToken(t, db);
    expect(tokenCacheSize()).toBe(0);
    invalidateTokenCache();
    await revokeAllForUserClient(userId, clientId, "user_disconnected", db);
    expect(await verifyAccessToken(t, db)).toEqual({ ok: false, reason: "revoked" });
  });
});

describe("metrics counters and health", () => {
  it("401s and tool outcomes are counted into admin metrics", async () => {
    const before = await getMetrics(db);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    await handleMcpRequest(new Request(env.mcpResource, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer junk" }, body }));
    await handleMcpRequest(new Request(env.mcpResource, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body }));
    await countEvent(db, "mcp:tool_ok");
    await countEvent(db, "mcp:tool_ok");
    await countEvent(db, "mcp:tool_error");
    const after = await getMetrics(db);
    expect(after.mcp.unauthorized24h - before.mcp.unauthorized24h).toBe(2);
    expect(after.mcp.toolCalls24h - before.mcp.toolCalls24h).toBe(3);
    expect(after.mcp.toolErrors24h - before.mcp.toolErrors24h).toBe(1);
    expect(after.mcp.clients).toBeGreaterThanOrEqual(1);
    expect(await sumEvents(db, "mcp:tool_ok")).toBeGreaterThanOrEqual(2);
    // metrics survive the daily rate-limit prune
    await pruneRateLimitWindows(db);
    expect(await sumEvents(db, "mcp:tool_ok")).toBeGreaterThanOrEqual(2);
  });

  it("dispatcher heartbeat age drives the health signal", async () => {
    const m0 = await getMetrics(db);
    expect(m0.worker.lastDispatchAt).toBeNull();
    await db.query("insert into audit_events (action, target_type, target_id) values ('worker.heartbeat','worker','dispatch')");
    const m1 = await getMetrics(db);
    expect(m1.worker.minutesSinceDispatch).toBe(0);
  });
});
