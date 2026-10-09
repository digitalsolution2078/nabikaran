import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, fund } from "./helpers/db";
import type { Db } from "@/lib/db";
import { env } from "@/lib/env";
import { registerClient, isAllowedRedirectUri, redirectUriMatches, authenticateClient } from "@/lib/oauth/clients";
import { validateAuthorizeRequest, issueAuthorizationCode, AuthorizeError } from "@/lib/oauth/codes";
import { exchangeToken, revokeToken, verifyAccessToken, revokeAllForUserClient, listConnections } from "@/lib/oauth/tokens";
import { makePkcePair, sha256hex } from "@/lib/oauth/pkce";
import { authorizationServerMetadata, protectedResourceMetadata, wwwAuthenticate } from "@/lib/oauth/metadata";
import { OAuthError } from "@/lib/oauth/errors";
import { listReminders, createReminder } from "@/lib/core/reminders";
import { ScopeError } from "@/lib/core/errors";

let db: Db;
let close: () => Promise<void> = async () => undefined;
let userId: string;
let clientId: string;
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  userId = await createUser(db, "+9779841000601");
  const { client } = await registerClient({ client_name: "ChatGPT", redirect_uris: [REDIRECT] }, {}, db);
  clientId = client.id;
});
afterAll(() => close());

/** Full happy-path: authorize → code → token. */
async function login(scope = "reminders:read reminders:write wallet:read account:read", uid = userId, cid = clientId) {
  const pkce = makePkcePair();
  const v = await validateAuthorizeRequest({ response_type: "code", client_id: cid, redirect_uri: REDIRECT, scope, state: "s", code_challenge: pkce.challenge, code_challenge_method: "S256", resource: env.mcpResource }, db);
  const code = await issueAuthorizationCode(v, uid, db);
  const tokens = await exchangeToken({ grant_type: "authorization_code", client_id: cid, code, redirect_uri: REDIRECT, code_verifier: pkce.verifier }, db);
  return { tokens, pkce, code };
}

describe("registration", () => {
  it("validates redirect URIs: https, loopback http, private schemes; rejects the rest", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:6274/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1/cb")).toBe(true);
    expect(isAllowedRedirectUri("com.example.app:/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://evil.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("https://x.com/cb#frag")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    expect(redirectUriMatches("http://localhost:1234/cb", "http://localhost:9999/cb")).toBe(true);
    expect(redirectUriMatches("https://a.com/cb", "https://a.com/cb2")).toBe(false);
  });
  it("rejects bad metadata and supports confidential clients", async () => {
    await expect(registerClient({ client_name: "x", redirect_uris: [] }, {}, db)).rejects.toThrow(OAuthError);
    await expect(registerClient({ client_name: "x", redirect_uris: ["http://evil/cb"] }, {}, db)).rejects.toMatchObject({ error: "invalid_redirect_uri" });
    await expect(registerClient({ client_name: "x", redirect_uris: [REDIRECT], grant_types: ["implicit"] }, {}, db)).rejects.toMatchObject({ error: "invalid_client_metadata" });
    const { client, clientSecret } = await registerClient({ client_name: "Server app", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" }, {}, db);
    expect(clientSecret).toBeTruthy();
    expect(client.client_secret_hash).toBe(sha256hex(clientSecret!));
    await expect(authenticateClient(client.id, "wrong", db)).rejects.toMatchObject({ error: "invalid_client", status: 401 });
    expect((await authenticateClient(client.id, clientSecret, db)).id).toBe(client.id);
  });
});

describe("authorization request", () => {
  const good = () => ({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope: "reminders:read", state: "abc", code_challenge: makePkcePair().challenge, code_challenge_method: "S256", resource: env.mcpResource });
  it("requires PKCE S256, exact redirect_uri, known scopes and the MCP resource", async () => {
    await expect(validateAuthorizeRequest({ ...good(), code_challenge: null }, db)).rejects.toMatchObject({ error: "invalid_request", redirectable: true });
    await expect(validateAuthorizeRequest({ ...good(), code_challenge_method: "plain" }, db)).rejects.toMatchObject({ error: "invalid_request" });
    await expect(validateAuthorizeRequest({ ...good(), redirect_uri: "https://attacker.example/cb" }, db)).rejects.toMatchObject({ error: "invalid_redirect_uri", redirectable: false });
    await expect(validateAuthorizeRequest({ ...good(), scope: "admin:write" }, db)).rejects.toMatchObject({ error: "invalid_scope" });
    await expect(validateAuthorizeRequest({ ...good(), resource: "https://other.example/mcp" }, db)).rejects.toMatchObject({ error: "invalid_target" });
    await expect(validateAuthorizeRequest({ ...good(), client_id: "nb_nope" }, db)).rejects.toBeInstanceOf(AuthorizeError);
    const v = await validateAuthorizeRequest({ ...good(), scope: null, resource: null }, db);
    expect(v.scopes).toHaveLength(4); // default: all scopes, resource defaults to the MCP endpoint
    expect(v.resource).toBe(env.mcpResource);
  });
});

describe("token endpoint", () => {
  it("exchanges a code once with the right verifier; replay revokes derived tokens", async () => {
    const { tokens, pkce, code } = await login();
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope.split(" ")).toHaveLength(4);
    const ok = await verifyAccessToken(tokens.access_token, db);
    expect(ok.ok && ok.principal.userId).toBe(userId);
    // replay of the same code → invalid_grant and the tokens it produced are revoked
    await expect(exchangeToken({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: pkce.verifier }, db)).rejects.toMatchObject({ error: "invalid_grant" });
    expect(await verifyAccessToken(tokens.access_token, db)).toEqual({ ok: false, reason: "revoked" });
  });

  it("rejects a wrong verifier, wrong client, wrong redirect_uri and expired codes", async () => {
    const pkce = makePkcePair();
    const v = await validateAuthorizeRequest({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce.challenge, code_challenge_method: "S256" }, db);
    const code = await issueAuthorizationCode(v, userId, db);
    await expect(exchangeToken({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: makePkcePair().verifier }, db)).rejects.toMatchObject({ error: "invalid_grant", description: /PKCE/ });
    // a failed PKCE check consumed the code: nothing further can be minted from it
    await expect(exchangeToken({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: pkce.verifier }, db)).rejects.toMatchObject({ error: "invalid_grant" });

    const { client: other } = await registerClient({ client_name: "Other", redirect_uris: [REDIRECT] }, {}, db);
    const p2 = makePkcePair();
    const v2 = await validateAuthorizeRequest({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: p2.challenge, code_challenge_method: "S256" }, db);
    const code2 = await issueAuthorizationCode(v2, userId, db);
    await expect(exchangeToken({ grant_type: "authorization_code", client_id: other.id, code: code2, code_verifier: p2.verifier }, db)).rejects.toMatchObject({ error: "invalid_grant" });
    await expect(exchangeToken({ grant_type: "authorization_code", client_id: clientId, code: code2, redirect_uri: "https://chatgpt.com/other", code_verifier: p2.verifier }, db)).rejects.toMatchObject({ error: "invalid_grant" });

    const p3 = makePkcePair();
    const v3 = await validateAuthorizeRequest({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: p3.challenge, code_challenge_method: "S256" }, db);
    const code3 = await issueAuthorizationCode(v3, userId, db);
    await db.query("update oauth_authorization_codes set expires_at = now() - interval '1 minute' where code_hash = $1", [sha256hex(code3)]);
    await expect(exchangeToken({ grant_type: "authorization_code", client_id: clientId, code: code3, code_verifier: p3.verifier }, db)).rejects.toMatchObject({ description: /expired/ });
    await expect(exchangeToken({ grant_type: "password", client_id: clientId }, db)).rejects.toMatchObject({ error: "unsupported_grant_type" });
  });

  it("stores only hashes", async () => {
    const { tokens } = await login();
    const { rows } = await db.query<{ token_hash: string }>("select token_hash from oauth_tokens where token_hash in ($1, $2)", [tokens.access_token, tokens.refresh_token]);
    expect(rows).toHaveLength(0);
    const { rows: hashed } = await db.query("select 1 from oauth_tokens where token_hash = $1", [sha256hex(tokens.access_token)]);
    expect(hashed).toHaveLength(1);
  });

  it("rotates refresh tokens; reuse of a rotated token kills the family", async () => {
    const { tokens: t1 } = await login();
    const t2 = await exchangeToken({ grant_type: "refresh_token", client_id: clientId, refresh_token: t1.refresh_token }, db);
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect(await verifyAccessToken(t1.access_token, db)).toEqual({ ok: false, reason: "revoked" });
    expect((await verifyAccessToken(t2.access_token, db)).ok).toBe(true);
    // narrowing scope on refresh is allowed, widening is not
    const t3 = await exchangeToken({ grant_type: "refresh_token", client_id: clientId, refresh_token: t2.refresh_token, scope: "reminders:read" }, db);
    expect(t3.scope).toBe("reminders:read");
    await expect(exchangeToken({ grant_type: "refresh_token", client_id: clientId, refresh_token: t3.refresh_token, scope: "reminders:read reminders:write" }, db)).rejects.toMatchObject({ error: "invalid_scope" });
    // attacker replays t1's (rotated) refresh token → everything in the family dies, including the newest
    await expect(exchangeToken({ grant_type: "refresh_token", client_id: clientId, refresh_token: t1.refresh_token }, db)).rejects.toMatchObject({ error: "invalid_grant" });
    expect(await verifyAccessToken(t3.access_token, db)).toEqual({ ok: false, reason: "revoked" });
    await expect(exchangeToken({ grant_type: "refresh_token", client_id: clientId, refresh_token: t3.refresh_token }, db)).rejects.toMatchObject({ error: "invalid_grant" });
    const { rows } = await db.query("select 1 from audit_events where action = 'oauth.refresh_reuse_detected'");
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("resource server token validation", () => {
  it("builds a Principal only from a valid token; AI-supplied ids are irrelevant", async () => {
    const { tokens } = await login("reminders:read");
    const r = await verifyAccessToken(tokens.access_token, db);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.principal).toMatchObject({ userId, via: "mcp", clientId, scopes: ["reminders:read"] });
    expect(r.principal.tokenId).toMatch(/^[0-9a-f-]{36}$/);
    // token scope is enforced by core
    await expect(createReminder(r.principal, { category: "other", label: "x", calendar: "AD", expiryDate: "2030-01-01", localTime: "09:00", offsets: [0], notes: null, familyMemberLabel: null }, {}, db)).rejects.toThrow(ScopeError);
    expect((await listReminders(r.principal, {}, db)).reminders).toEqual([]);
  });

  it("rejects missing, garbage, expired, revoked, wrong-resource and inactive-account tokens", async () => {
    expect(await verifyAccessToken(null, db)).toEqual({ ok: false, reason: "missing" });
    expect(await verifyAccessToken("nope", db)).toEqual({ ok: false, reason: "invalid" });
    const { tokens } = await login();
    await db.query("update oauth_tokens set expires_at = now() - interval '1 second' where token_hash = $1", [sha256hex(tokens.access_token)]);
    expect(await verifyAccessToken(tokens.access_token, db)).toEqual({ ok: false, reason: "expired" });
    const { tokens: t2 } = await login();
    await db.query("update oauth_tokens set resource = 'https://other/mcp' where token_hash = $1", [sha256hex(t2.access_token)]);
    expect(await verifyAccessToken(t2.access_token, db)).toEqual({ ok: false, reason: "wrong_resource" });
    const { tokens: t3 } = await login();
    await revokeToken({ token: t3.access_token, client_id: clientId }, db);
    expect(await verifyAccessToken(t3.access_token, db)).toEqual({ ok: false, reason: "revoked" });
    const closed = await createUser(db, "+9779841000602");
    const { tokens: t4 } = await login(undefined, closed);
    await db.query("update users set status = 'closed' where id = $1", [closed]);
    expect(await verifyAccessToken(t4.access_token, db)).toEqual({ ok: false, reason: "account_inactive" });
    await expect(exchangeToken({ grant_type: "refresh_token", client_id: clientId, refresh_token: t4.refresh_token }, db)).rejects.toMatchObject({ description: /not active/ });
  });

  it("user isolation across tokens: a token for Bob never sees Alice", async () => {
    const bob = await createUser(db, "+9779841000603");
    await fund(db, userId, 10);
    await createReminder({ userId, via: "web", scopes: ["reminders:write"], locale: "ne-NP" }, { category: "other", label: "Alice only", calendar: "AD", expiryDate: "2030-01-01", localTime: "09:00", offsets: [0], notes: null, familyMemberLabel: null }, {}, db);
    const { tokens } = await login(undefined, bob);
    const r = await verifyAccessToken(tokens.access_token, db);
    if (!r.ok) throw new Error("expected token");
    expect((await listReminders(r.principal, { status: "all" }, db)).reminders.some((x) => x.label === "Alice only")).toBe(false);
  });

  it("Settings → Disconnect revokes every token of that client; connections list reflects it", async () => {
    const { tokens } = await login();
    const before = await listConnections(userId, db);
    expect(before.some((c) => c.clientId === clientId)).toBe(true);
    const n = await revokeAllForUserClient(userId, clientId, "user_disconnected", db);
    expect(n).toBeGreaterThan(0);
    expect(await verifyAccessToken(tokens.access_token, db)).toEqual({ ok: false, reason: "revoked" });
    expect((await listConnections(userId, db)).some((c) => c.clientId === clientId)).toBe(false);
  });

  it("revocation endpoint ignores tokens of other clients and unknown tokens", async () => {
    const { tokens } = await login();
    const { client: other } = await registerClient({ client_name: "Other2", redirect_uris: [REDIRECT] }, {}, db);
    await revokeToken({ token: tokens.access_token, client_id: other.id }, db);
    expect((await verifyAccessToken(tokens.access_token, db)).ok).toBe(true);
    await revokeToken({ token: "unknown", client_id: clientId }, db);
    await expect(revokeToken({ token: tokens.access_token, client_id: "nb_missing" }, db)).rejects.toMatchObject({ error: "invalid_client" });
  });
});

describe("discovery metadata", () => {
  it("advertises PKCE S256, code grant, registration and the MCP resource", () => {
    const as = authorizationServerMetadata();
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(as.registration_endpoint).toMatch(/\/oauth\/register$/);
    const rs = protectedResourceMetadata();
    expect(rs.resource).toBe(env.mcpResource);
    expect(rs.authorization_servers[0]).toBe(as.issuer);
    expect(wwwAuthenticate()).toMatch(/^Bearer resource_metadata="http.*\/\.well-known\/oauth-protected-resource"$/);
  });
});
