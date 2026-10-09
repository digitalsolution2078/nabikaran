import { randomUUID } from "node:crypto";
import { getDb, type Db } from "../db";
import { env } from "../env";
import { mcpPrincipal, type Principal, type Scope } from "../core/principal";
import { OAuthError } from "./errors";
import { authenticateClient, type ClientRow } from "./clients";
import { consumeAuthorizationCode } from "./codes";
import { randomToken, sha256hex, verifyPkce } from "./pkce";

/**
 * Opaque bearer tokens (256-bit random, SHA-256 at rest). Access tokens live
 * 1 h; refresh tokens 30 d and are rotated on every use. Presenting a refresh
 * token that was already rotated means it leaked: the whole family is revoked.
 */
export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface TokenRow {
  id: string;
  user_id: string;
  client_id: string;
  kind: "access" | "refresh";
  family_id: string;
  scopes: string[];
  resource: string;
  expires_at: string;
  revoked_at: string | null;
}

async function issuePair(tx: Db, userId: string, clientId: string, scopes: Scope[], resource: string, familyId: string): Promise<TokenResponse> {
  const access = randomToken(32);
  const refresh = randomToken(32);
  await tx.query(
    `insert into oauth_tokens (user_id, client_id, kind, token_hash, family_id, scopes, resource, expires_at) values
       ($1,$2,'access',$3,$5,$6,$7, now() + make_interval(secs => $8)),
       ($1,$2,'refresh',$4,$5,$6,$7, now() + make_interval(secs => $9))`,
    [userId, clientId, sha256hex(access), sha256hex(refresh), familyId, scopes, resource, env.oauth.accessTtlSeconds, env.oauth.refreshTtlSeconds],
  );
  return { access_token: access, token_type: "Bearer", expires_in: env.oauth.accessTtlSeconds, refresh_token: refresh, scope: scopes.join(" ") };
}

export interface TokenRequest {
  grant_type?: string;
  code?: string;
  redirect_uri?: string;
  code_verifier?: string;
  refresh_token?: string;
  client_id?: string;
  client_secret?: string;
  resource?: string;
  scope?: string;
}

export async function exchangeToken(req: TokenRequest, db: Db = getDb()): Promise<TokenResponse> {
  const client = await authenticateClient(req.client_id, req.client_secret, db);
  if (req.grant_type === "authorization_code") return exchangeCode(client, req, db);
  if (req.grant_type === "refresh_token") return refreshTokens(client, req, db);
  throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}

type CodeOutcome =
  | { kind: "ok"; pair: TokenResponse }
  | { kind: "replay"; userId: string }
  | { kind: "fail"; error: OAuthError };

async function exchangeCode(client: ClientRow, req: TokenRequest, db: Db): Promise<TokenResponse> {
  if (!req.code) throw new OAuthError("invalid_request", "code is required");
  if (!req.code_verifier) throw new OAuthError("invalid_request", "code_verifier is required");
  // The transaction commits even when the grant is refused, so a consumed code
  // stays consumed and cannot be retried with a different verifier.
  const outcome = await db.tx<CodeOutcome>(async (tx) => {
    const c = await consumeAuthorizationCode(tx, req.code!);
    if (c.clientId !== client.id) return { kind: "fail", error: new OAuthError("invalid_grant", "code was issued to a different client") };
    if (c.replayed) return { kind: "replay", userId: c.userId };
    if (req.redirect_uri !== undefined && req.redirect_uri !== c.redirectUri) return { kind: "fail", error: new OAuthError("invalid_grant", "redirect_uri mismatch") };
    if (!verifyPkce(req.code_verifier!, c.codeChallenge)) return { kind: "fail", error: new OAuthError("invalid_grant", "PKCE verification failed") };
    if (req.resource !== undefined && req.resource !== c.resource) return { kind: "fail", error: new OAuthError("invalid_target", "resource mismatch") };
    const pair = await issuePair(tx, c.userId, client.id, c.scopes, c.resource, randomUUID());
    await tx.query("insert into audit_events (actor_user_id, actor_via, actor_client_id, action, target_type, target_id, json_detail_redacted) values ($1,'system',$2,'oauth.token_issued','oauth_client',$2,$3)", [
      c.userId, client.id, JSON.stringify({ scopes: c.scopes }),
    ]);
    return { kind: "ok", pair };
  });
  if (outcome.kind === "ok") return outcome.pair;
  if (outcome.kind === "replay") {
    // OAuth 2.1 §4.1.2: a replayed code revokes everything derived from it.
    await db.query("update oauth_tokens set revoked_at = now(), revoke_reason = 'code_replay' where user_id = $1 and client_id = $2 and revoked_at is null", [outcome.userId, client.id]);
    await db.query("insert into audit_events (actor_user_id, actor_via, actor_client_id, action, target_type, target_id) values ($1,'system',$2,'oauth.code_replay_detected','oauth_client',$2)", [outcome.userId, client.id]);
    throw new OAuthError("invalid_grant", "authorization code already used");
  }
  throw outcome.error;
}

type RefreshOutcome =
  | { kind: "ok"; pair: TokenResponse }
  | { kind: "reuse"; familyId: string; userId: string }
  | { kind: "fail"; error: OAuthError };

async function refreshTokens(client: ClientRow, req: TokenRequest, db: Db): Promise<TokenResponse> {
  if (!req.refresh_token) throw new OAuthError("invalid_request", "refresh_token is required");
  const outcome = await db.tx<RefreshOutcome>(async (tx) => {
    const { rows } = await tx.query<TokenRow>("select * from oauth_tokens where token_hash = $1 and kind = 'refresh' for update", [sha256hex(req.refresh_token!)]);
    const t = rows[0];
    if (!t || t.client_id !== client.id) return { kind: "fail", error: new OAuthError("invalid_grant", "unknown refresh token") };
    if (t.revoked_at) return { kind: "reuse", familyId: t.family_id, userId: t.user_id };
    if (new Date(t.expires_at).getTime() < Date.now()) return { kind: "fail", error: new OAuthError("invalid_grant", "refresh token expired") };
    const { rows: u } = await tx.query<{ status: string }>("select status from users where id = $1", [t.user_id]);
    if (u[0]?.status !== "active") return { kind: "fail", error: new OAuthError("invalid_grant", "account not active") };
    let scopes = t.scopes as Scope[];
    if (req.scope) {
      const requested = req.scope.split(/\s+/).filter(Boolean);
      if (requested.some((s) => !scopes.includes(s as Scope))) return { kind: "fail", error: new OAuthError("invalid_scope", "cannot widen scope on refresh") };
      scopes = requested as Scope[];
    }
    // Rotate: retire the old refresh token and any access tokens from the previous issuance.
    await tx.query("update oauth_tokens set revoked_at = now(), revoke_reason = 'rotated' where family_id = $1 and revoked_at is null", [t.family_id]);
    const pair = await issuePair(tx, t.user_id, client.id, scopes, t.resource, t.family_id);
    await tx.query("insert into audit_events (actor_user_id, actor_via, actor_client_id, action, target_type, target_id) values ($1,'system',$2,'oauth.token_refreshed','oauth_token_family',$3)", [t.user_id, client.id, t.family_id]);
    return { kind: "ok", pair };
  });
  invalidateTokenCache();
  if (outcome.kind === "ok") return outcome.pair;
  if (outcome.kind === "reuse") {
    // Reuse of a rotated token: assume theft, kill the whole family (committed outside the refused grant).
    await db.query("update oauth_tokens set revoked_at = coalesce(revoked_at, now()), revoke_reason = coalesce(revoke_reason, 'refresh_reuse') where family_id = $1", [outcome.familyId]);
    await db.query("insert into audit_events (actor_user_id, actor_via, actor_client_id, action, target_type, target_id) values ($1,'system',$2,'oauth.refresh_reuse_detected','oauth_token_family',$3)", [outcome.userId, client.id, outcome.familyId]);
    throw new OAuthError("invalid_grant", "refresh token revoked");
  }
  throw outcome.error;
}

/** RFC 7009. Always succeeds from the caller's point of view. */
export async function revokeToken(req: { token?: string; token_type_hint?: string; client_id?: string; client_secret?: string }, db: Db = getDb()): Promise<void> {
  const client = await authenticateClient(req.client_id, req.client_secret, db);
  if (!req.token) return;
  const { rows } = await db.query<TokenRow>("select * from oauth_tokens where token_hash = $1", [sha256hex(req.token)]);
  const t = rows[0];
  if (!t || t.client_id !== client.id) return;
  if (t.kind === "refresh") {
    await db.query("update oauth_tokens set revoked_at = coalesce(revoked_at, now()), revoke_reason = coalesce(revoke_reason, 'client_revoked') where family_id = $1", [t.family_id]);
  } else {
    await db.query("update oauth_tokens set revoked_at = coalesce(revoked_at, now()), revoke_reason = coalesce(revoke_reason, 'client_revoked') where id = $1", [t.id]);
  }
  await db.query("insert into audit_events (actor_user_id, actor_via, actor_client_id, action, target_type, target_id) values ($1,'system',$2,'oauth.token_revoked','oauth_token_family',$3)", [t.user_id, client.id, t.family_id]);
  invalidateTokenCache();
}

/** Settings → Disconnect, account closure, admin kill-switch. */
export async function revokeAllForUserClient(userId: string, clientId: string | null, reason: string, db: Db = getDb()): Promise<number> {
  const { rowCount } = await db.query(
    "update oauth_tokens set revoked_at = now(), revoke_reason = $3 where user_id = $1 and ($2::text is null or client_id = $2) and revoked_at is null",
    [userId, clientId, reason],
  );
  await db.query("insert into audit_events (actor_user_id, actor_via, actor_client_id, action, target_type, target_id, json_detail_redacted) values ($1,'web',$2,'oauth.disconnected','oauth_client',$2,$3)", [
    userId, clientId, JSON.stringify({ reason, revoked: rowCount ?? 0 }),
  ]);
  invalidateTokenCache();
  return rowCount ?? 0;
}

export type VerifyFailure = "missing" | "invalid" | "expired" | "revoked" | "wrong_resource" | "account_inactive";

/**
 * Per-instance positive cache for access-token lookups (docs §4.3). Bounded
 * TTL keeps the revocation delay short; revocations made through this instance
 * drop the cache immediately. Disabled when TOKEN_CACHE_SECONDS=0 (tests).
 */
const tokenCache = new Map<string, { principal: Principal; until: number }>();
const TOKEN_CACHE_MS = Number(process.env.TOKEN_CACHE_SECONDS ?? (process.env.NODE_ENV === "test" ? 0 : 30)) * 1000;
const TOKEN_CACHE_MAX = 5000;

export function invalidateTokenCache(): void {
  tokenCache.clear();
}

export function tokenCacheSize(): number {
  return tokenCache.size;
}

/**
 * Resource-server side: turn a bearer token into a Principal. This is the ONLY
 * way an MCP request obtains an identity (docs §4.3). Never trusts any user id
 * supplied by the client.
 */
export async function verifyAccessToken(token: string | null | undefined, db: Db = getDb()): Promise<{ ok: true; principal: Principal } | { ok: false; reason: VerifyFailure }> {
  if (!token) return { ok: false, reason: "missing" };
  if (token.length > 256) return { ok: false, reason: "invalid" };
  const hash = sha256hex(token);
  const cached = TOKEN_CACHE_MS > 0 ? tokenCache.get(hash) : undefined;
  if (cached && cached.until > Date.now()) return { ok: true, principal: cached.principal };
  const { rows } = await db.query<TokenRow & { user_status: string; phone_verified_at: string | null; locale: string; client_disabled: string | null }>(
    `select t.*, u.status as user_status, u.phone_verified_at, u.locale, c.disabled_at as client_disabled
       from oauth_tokens t join users u on u.id = t.user_id join oauth_clients c on c.id = t.client_id
      where t.token_hash = $1 and t.kind = 'access'`,
    [hash],
  );
  const t = rows[0];
  if (!t) return { ok: false, reason: "invalid" };
  if (t.revoked_at || t.client_disabled) return { ok: false, reason: "revoked" };
  if (new Date(t.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" };
  if (t.resource !== env.mcpResource) return { ok: false, reason: "wrong_resource" };
  if (t.user_status !== "active" || !t.phone_verified_at) return { ok: false, reason: "account_inactive" };
  // Throttled last-used stamp (at most once a minute per token) to keep writes cheap.
  await db.query("update oauth_tokens set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')", [t.id]);
  const principal = mcpPrincipal({ userId: t.user_id, locale: t.locale, scopes: t.scopes as Scope[], clientId: t.client_id, tokenId: t.id });
  if (TOKEN_CACHE_MS > 0) {
    if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
    tokenCache.set(hash, { principal, until: Math.min(Date.now() + TOKEN_CACHE_MS, new Date(t.expires_at).getTime()) });
  }
  return { ok: true, principal };
}

export interface ConnectionView {
  clientId: string;
  name: string;
  scopes: string[];
  connectedAt: string;
  lastUsedAt: string | null;
}

export async function listConnections(userId: string, db: Db = getDb()): Promise<ConnectionView[]> {
  const { rows } = await db.query<{ client_id: string; name: string; scopes: string[]; connected_at: string; last_used_at: string | null }>(
    `select t.client_id, c.name, t.scopes, min(t.created_at) as connected_at, max(t.last_used_at) as last_used_at
       from oauth_tokens t join oauth_clients c on c.id = t.client_id
      where t.user_id = $1 and t.kind = 'refresh' and t.revoked_at is null and t.expires_at > now()
      group by t.client_id, c.name, t.scopes order by connected_at desc`,
    [userId],
  );
  return rows.map((r) => ({ clientId: r.client_id, name: r.name, scopes: r.scopes, connectedAt: new Date(r.connected_at).toISOString(), lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null }));
}

/** Admin kill-switch: a disabled client's tokens stop validating at once; enabling restores them (unless revoked). */
export async function setClientDisabled(actorId: string, clientId: string, disabled: boolean, db: Db = getDb()): Promise<boolean> {
  const { rowCount } = await db.query("update oauth_clients set disabled_at = case when $2 then coalesce(disabled_at, now()) else null end where id = $1", [clientId, disabled]);
  if ((rowCount ?? 0) === 0) return false;
  await db.query("insert into audit_events (actor_user_id, actor_via, actor_client_id, action, target_type, target_id) values ($1,'web',$2,$3,'oauth_client',$2)", [
    actorId, clientId, disabled ? "oauth.client_disabled" : "oauth.client_enabled",
  ]);
  invalidateTokenCache();
  return true;
}

export interface ClientAdminView {
  id: string;
  name: string;
  createdAt: string;
  disabledAt: string | null;
  activeUsers: number;
  activeTokens: number;
}

export async function listClientsForAdmin(db: Db = getDb()): Promise<ClientAdminView[]> {
  const { rows } = await db.query<{ id: string; name: string; created_at: string; disabled_at: string | null; active_users: string; active_tokens: string }>(
    `select c.id, c.name, c.created_at, c.disabled_at,
            (select count(distinct t.user_id) from oauth_tokens t where t.client_id = c.id and t.kind = 'refresh' and t.revoked_at is null and t.expires_at > now())::text as active_users,
            (select count(*) from oauth_tokens t where t.client_id = c.id and t.kind = 'access' and t.revoked_at is null and t.expires_at > now())::text as active_tokens
       from oauth_clients c order by c.created_at desc limit 200`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: new Date(r.created_at).toISOString(), disabledAt: r.disabled_at ? new Date(r.disabled_at).toISOString() : null, activeUsers: Number(r.active_users), activeTokens: Number(r.active_tokens) }));
}

/** Housekeeping (reconciler): purge expired codes and long-expired tokens. */
export async function pruneOAuth(db: Db = getDb()): Promise<void> {
  await db.query("delete from oauth_authorization_codes where expires_at < now() - interval '1 day'");
  await db.query("delete from oauth_tokens where expires_at < now() - interval '30 days'");
}
